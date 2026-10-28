import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(repositoryRoot, 'dist', 'pi-worker.mjs');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pi-chat-worker-smoke-'));
const workspacePath = join(temporaryRoot, 'workspace');
const projectPath = join(workspacePath, 'nested');
const agentDir = join(temporaryRoot, 'agent');
const extensionDir = join(agentDir, 'extensions');
const extraExtensionPath = join(temporaryRoot, 'extra-smoke-extension.mjs');
const agentSkillPath = join(agentDir, 'skills', 'base-smoke-skill', 'SKILL.md');
const extraSkillPath = join(temporaryRoot, 'extra-smoke-skill.md');
const agentPromptPath = join(agentDir, 'prompts', 'base-smoke-prompt.md');
const agentThemePath = join(agentDir, 'themes', 'base-smoke-theme.json');
const extraPromptPath = join(temporaryRoot, 'extra-smoke-prompt.md');
const extraThemePath = join(temporaryRoot, 'extra-smoke-theme.json');
const appendedPromptPath = join(temporaryRoot, 'appended-system-prompt.md');
const providerCallsPath = join(temporaryRoot, 'provider-calls.jsonl');
const bashCallsPath = join(temporaryRoot, 'bash-calls.jsonl');
await Promise.all([
  mkdir(projectPath, { recursive: true }),
  mkdir(extensionDir, { recursive: true }),
  mkdir(dirname(agentSkillPath), { recursive: true }),
  mkdir(dirname(agentPromptPath), { recursive: true }),
  mkdir(dirname(agentThemePath), { recursive: true }),
]);
await Promise.all([
  writeFile(providerCallsPath, ''),
  writeFile(bashCallsPath, ''),
  writeFile(extraExtensionPath, `export default function (pi) {
  pi.registerCommand('extra-smoke-command', {
    description: 'Explicitly added extension for the isolated smoke check.',
    handler: async () => undefined,
  });
}
`),
  writeFile(join(workspacePath, 'AGENTS.md'), 'Temporary parent workspace instructions for the isolated smoke check.\n'),
  writeFile(join(projectPath, 'CLAUDE.md'), 'Temporary nested workspace instructions for the isolated smoke check.\n'),
  writeFile(agentSkillPath, '---\nname: base-smoke-skill\ndescription: Baseline skill for the isolated smoke check.\n---\nBASE_SMOKE_SKILL_MARKER\n'),
  writeFile(extraSkillPath, '---\nname: extra-smoke-skill\ndescription: Explicitly added skill for the isolated smoke check.\n---\nEXTRA_SMOKE_SKILL_MARKER\n'),
  writeFile(agentPromptPath, '---\nname: base-smoke-prompt\ndescription: Baseline prompt template for the isolated smoke check.\n---\nBASE_SMOKE_PROMPT_MARKER\n'),
  writeFile(agentThemePath, JSON.stringify({ name: 'base-smoke-theme', colors: {} })),
  writeFile(extraPromptPath, '---\nname: extra-smoke-prompt\ndescription: Explicitly added prompt template for the isolated smoke check.\n---\nEXTRA_SMOKE_PROMPT_MARKER\n'),
  writeFile(appendedPromptPath, 'APPENDED_SYSTEM_PROMPT_FILE_MARKER\n'),
  writeFile(extraThemePath, JSON.stringify({ name: 'smoke-theme', colors: {} })),
]);

let worker;
const messages = [];
let streamedAssistantText = '';
let assistantUpdateCount = 0;

function waitForWorkerMessage(predicate, label, timeoutMs = 15_000) {
  return new Promise((resolveMessage, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      if (error) reject(error);
      else resolveMessage(message);
    };
    const onMessage = (message) => {
      messages.push(message);
      if (predicate(message)) finish(undefined, message);
      else if (message?.type === 'runtime-error') finish(new Error(message.message || 'Pi worker reported a runtime error.'));
    };
    const onError = (error) => finish(error);
    const timer = setTimeout(() => {
      const recentEvents = messages.slice(-12).map((message) => {
        const transcriptDetail = Array.isArray(message?.messages)
          ? message.messages.filter((entry) => entry?.role === 'assistant')
            .map((entry) => `${Object.keys(entry).join(',')} ${entry.text || entry.errorMessage || entry.stopReason || ''}`).join(' / ')
          : '';
        const detail = [message?.text, message?.message, message?.error, transcriptDetail]
          .find((value) => typeof value === 'string' && value.length > 0);
        const diagnostic = detail || Object.keys(message || {}).filter((key) => key !== 'messages').join(',');
        return `${String(message?.type || 'unknown')}${diagnostic ? `: ${String(diagnostic).slice(0, 160)}` : ''}`;
      }).join(' | ');
      finish(new Error(`Timed out waiting for ${label}. Assistant updates: ${assistantUpdateCount}; output: ${streamedAssistantText.slice(0, 120)}. Recent worker events: ${recentEvents || '(none)'}.`));
    }, timeoutMs);
    worker.on('message', onMessage);
    worker.once('error', onError);
  });
}

try {
  const streamModuleUrl = pathToFileURL(join(repositoryRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'event-stream.js')).href;
  const extensionSource = `
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from ${JSON.stringify(streamModuleUrl)};
const callLogPath = ${JSON.stringify(providerCallsPath)};
const bashCallLogPath = ${JSON.stringify(bashCallsPath)};
const usage = () => ({ input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => part && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\\n');
}
export default function (pi) {
  pi.registerProvider('pi-chat-smoke', {
    name: 'Pi Chat Local Smoke',
    baseUrl: 'https://smoke.invalid/v1',
    apiKey: 'pi-chat-local-smoke-key',
    api: 'openai-completions',
    models: [
      { id: 'smoke-model', name: 'Local Smoke Model', reasoning: false, input: ['text'], contextWindow: 2048, maxTokens: 64 },
      { id: 'smoke-model-alt', name: 'Alternate Smoke Model', reasoning: true, input: ['text'], contextWindow: 2048, maxTokens: 64 },
    ],
    streamSimple(model, context) {
      const systemText = [context.systemPrompt, ...context.messages.filter((message) => message.role === 'system').flatMap((message) => [
        textOf(message.content),
        ...(message.sections && typeof message.sections === 'object' ? Object.values(message.sections).filter((section) => typeof section === 'string') : []),
      ])]
        .filter((value) => typeof value === 'string').join('\\n');
      const userMessages = context.messages.filter((message) => message.role === 'user').map((message) => textOf(message.content));
      const userHistoryText = userMessages.join('\\n');
      const userText = userMessages.at(-1) || '';
      const kind = systemText.includes('context summarization assistant') ? 'summarization'
        : systemText.includes('Create exactly three concise') ? 'suggestion-recovery'
          : systemText.includes('Suggest three concise') ? 'suggestion-primary'
            : userText.includes('LOCAL_QUEUE_BLOCKER') ? 'queue-blocker'
              : userText.includes('LOCAL_QUEUE_BEFORE_COMPACTION') ? 'queue-before-compaction'
                  : userText.includes('LOCAL_QUEUE_AFTER_COMPACTION') ? 'queue-after-compaction'
                    : userText.includes('LOCAL_QUEUE_AFTER_FAILURE') ? 'queue-after-failure' : 'main';
      const text = kind === 'summarization'
        ? '## Goal\\nVerify ordered Pi session operations.\\n\\n## Constraints & Preferences\\n- Preserve queued order.\\n\\n## Progress\\n### Done\\n- [x] Ran the initial request.\\n\\n### In Progress\\n- [ ] Continue the queued request.\\n\\n## Key Decisions\\n- Compaction stays in the session queue.\\n\\n## Critical Information\\n- This is isolated smoke data.\\n\\n## Files\\n- None.'
        : kind === 'queue-blocker' ? 'QUEUE_BLOCKER_DONE'
          : kind === 'queue-before-compaction' ? 'QUEUE_BEFORE_COMPACTION_DONE'
            : kind === 'queue-after-compaction' ? 'QUEUE_AFTER_COMPACTION_DONE'
              : kind === 'queue-after-failure' ? 'QUEUE_AFTER_FAILURE_DONE'
              : kind === 'suggestion-primary' ? '1. Identify one missing edge case in the implementation.'
                : kind === 'suggestion-recovery' ? '2. Suggest a focused regression test for the behavior.' : 'LOCAL_SMOKE_OK';
      appendFileSync(callLogPath, JSON.stringify({
        kind,
        hasSmokePrompt: userHistoryText.includes('LOCAL_SMOKE_REQUEST'),
        includedBashOutputCount: userHistoryText.split('USER_BASH_RESULT:included').length - 1,
        excludedBashOutputCount: userHistoryText.split('USER_BASH_RESULT:excluded').length - 1,
        hasCustomSystemPrompt: systemText.includes('CUSTOM_SYSTEM_PROMPT_MARKER'),
        hasAppendedPromptText: systemText.includes('APPENDED_SYSTEM_PROMPT_TEXT_MARKER'),
        hasAppendedPromptFile: systemText.includes('APPENDED_SYSTEM_PROMPT_FILE_MARKER'),
      }) + '\\n', { encoding: 'utf8', mode: 0o600 });
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now() };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      const finish = () => {
        if (kind === 'summarization' && userText.includes('FORCE_COMPACTION_FAILURE')) {
          message.stopReason = 'error';
          message.errorMessage = 'SMOKE_COMPACTION_FAILURE';
          stream.push({ type: 'done', reason: 'error', message });
          return;
        }
        message.content[0].text = text;
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
        message.stopReason = 'stop';
        stream.push({ type: 'done', reason: 'stop', message });
      };
      if (kind === 'queue-blocker') setTimeout(finish, 800);
      else finish();
      return stream;
    },
  });
  pi.on('user_bash', (event) => {
    const match = /^PI_CHAT_USER_BASH_SMOKE (included|excluded)$/.exec(event.command);
    if (!match) return;
    const output = 'USER_BASH_RESULT:' + match[1];
    appendFileSync(bashCallLogPath, JSON.stringify({ command: event.command, excludeFromContext: event.excludeFromContext, cwd: event.cwd }) + '\\n', { encoding: 'utf8', mode: 0o600 });
    return {
      operations: {
        async exec(_command, _cwd, { onData, signal }) {
          if (signal?.aborted) throw new Error('aborted');
          onData(Buffer.from(output));
          return { exitCode: 0 };
        },
      },
    };
  });
}
`;
  await writeFile(join(extensionDir, 'local-smoke.ts'), extensionSource, 'utf8');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'pi-chat-smoke': {
        name: 'Pi Chat Local Smoke',
        baseUrl: 'https://smoke.invalid/v1',
        api: 'openai-completions',
        apiKey: 'pi-chat-local-smoke-key',
        authHeader: true,
        models: [
          {
            id: 'smoke-model',
            name: 'Local Smoke Model',
            reasoning: false,
            input: ['text'],
            contextWindow: 2048,
            maxTokens: 64,
          },
          {
            id: 'smoke-model-alt',
            name: 'Alternate Smoke Model',
            reasoning: true,
            input: ['text'],
            contextWindow: 2048,
            maxTokens: 64,
          },
        ],
      },
    },
  }, null, 2));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'pi-chat-smoke',
    defaultModel: 'smoke-model',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'never',
    defaultTools: [],
    compaction: { reserveTokens: 256, keepRecentTokens: 128 },
  }, null, 2));

  const environment = {};
  for (const key of [
    'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'LANG', 'LC_ALL',
  ]) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  Object.assign(environment, {
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    APPDATA: temporaryRoot,
    LOCALAPPDATA: temporaryRoot,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
  });

  worker = new Worker(workerPath, {
    env: environment,
    workerData: {
      cwd: projectPath,
      extensionRoot: repositoryRoot,
      piPromptResources: {
        additionalExtensionPaths: [extraExtensionPath],
        systemPromptText: 'CUSTOM_SYSTEM_PROMPT_MARKER',
        appendSystemPromptText: 'APPENDED_SYSTEM_PROMPT_TEXT_MARKER',
        appendSystemPromptFiles: [appendedPromptPath],
        additionalSkillPaths: [extraSkillPath],
        additionalPromptTemplatePaths: [extraPromptPath],
        additionalThemePaths: [extraThemePath],
        disableThemeDiscovery: true,
      },
      autoNameSessions: false,
      autoRefreshModels: false,
      mcpEnabled: false,
      newSessionToolNames: ['read'],
      disabledContextFiles: [],
      disableContextFiles: false,
      extensionUiMode: 'rpc',
    },
  });
  worker.on('message', (message) => {
    if (message?.type === 'assistant-start') streamedAssistantText = '';
    else if (message?.type === 'assistant-delta' && typeof message.text === 'string') {
      streamedAssistantText += message.text;
      assistantUpdateCount += 1;
    } else if (message?.type === 'assistant-replace' && typeof message.text === 'string') {
      streamedAssistantText = message.text;
      assistantUpdateCount += 1;
    }
  });

  const ready = waitForWorkerMessage((message) => message?.type === 'worker-ready', 'Pi worker startup');
  await ready;
  const optionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.models)
    && message.models.some((model) => model.provider === 'pi-chat-smoke' && model.id === 'smoke-model'), 'configured model discovery');
  const newSessionToolOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.newSessionToolNames) && message.newSessionToolNames.includes('read')
    && Array.isArray(message.activeTools) && message.activeTools.includes('read'), 'new-session tool defaults');
  const initializedSessionPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && typeof message.sessionFile === 'string', 'new Pi session');
  const initializedSessionReadyPromise = waitForWorkerMessage((message) => message?.type === 'session-ready', 'Pi session readiness');
  worker.postMessage({ type: 'initializeSession' });
  const [discoveredOptions, newSessionToolOptions, initializedSession, initializedSessionReady] = await Promise.all([
    optionsPromise,
    newSessionToolOptionsPromise,
    initializedSessionPromise,
    initializedSessionReadyPromise,
  ]);
  assert.equal(discoveredOptions.providers.find((provider) => provider.id === 'pi-chat-smoke')?.configured, true,
    'the temporary Pi configuration should provide a local test credential');
  assert.deepEqual(newSessionToolOptions.activeTools, ['read'], 'the configured tool set should apply to new smoke sessions');
  assert.deepEqual(newSessionToolOptions.newSessionToolNames, ['read'], 'the worker should report its configured new-chat default');
  assert.deepEqual(discoveredOptions.contextFiles.map((item) => item.path).sort(), [join(projectPath, 'CLAUDE.md'), join(workspacePath, 'AGENTS.md')].sort(),
    'the default Pi runtime should load nested and parent instruction files');
  assert.ok(discoveredOptions.skills.some((skill) => skill.name === 'base-smoke-skill'),
    'Pi should keep discovering the configured agent-directory skills');
  assert.ok(discoveredOptions.skills.some((skill) => skill.name === 'extra-smoke-skill'),
    'an explicitly listed additional skill path should load');
  assert.ok(discoveredOptions.prompts.some((prompt) => prompt.name === 'base-smoke-prompt'),
    'Pi should keep discovering the configured agent-directory prompt templates');
  assert.ok(discoveredOptions.prompts.some((prompt) => prompt.name === 'extra-smoke-prompt'),
    'an explicitly listed additional prompt-template path should load');
  assert.ok(discoveredOptions.extensionCommands.some((command) => command.name === 'extra-smoke-command'),
    'an explicitly listed additional extension path should load');
  assert.ok(discoveredOptions.resourceDiagnostics.some((item) => item.resource === 'Theme' && item.path === extraThemePath),
    'an explicitly listed theme path should be checked even when automatic theme discovery is disabled');
  assert.ok(!discoveredOptions.resourceDiagnostics.some((item) => item.resource === 'Theme' && item.path === agentThemePath),
    'disabling theme discovery should skip themes from Pi’s default themes directory');

  const mismatchedShellCommandId = 'd'.repeat(32);
  const mismatchedShellCommandPromise = waitForWorkerMessage((message) => message?.type === 'shell-command-rejected'
    && message.commandId === mismatchedShellCommandId, 'session-bound shell-command rejection');
  worker.postMessage({
    type: 'runShellCommand',
    commandId: mismatchedShellCommandId,
    expectedSessionPath: join(projectPath, 'wrong-session.jsonl'),
    command: 'PI_CHAT_USER_BASH_SMOKE wrong-session',
    excludeFromContext: false,
  });
  const mismatchedShellCommand = await mismatchedShellCommandPromise;
  assert.match(mismatchedShellCommand.message, /active session changed/i,
    'Pi should reject a queued shell command when its session binding does not match');

  const sessionListRequestId = 'b'.repeat(32);
  const sessionListPromise = waitForWorkerMessage((message) => message?.type === 'sessions'
    && message.requestId === sessionListRequestId, 'Command Palette session list');
  worker.postMessage({ type: 'listSessions', query: '', allWorkspaces: false, requestId: sessionListRequestId });
  const sessionList = await sessionListPromise;
  assert.equal(sessionList.allWorkspaces, false, 'the session picker request should remain scoped to the current workspace');
  assert.ok(Array.isArray(sessionList.sessions), 'the session picker should receive a validated session list');

  const modelSnapshot = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && message.model === 'pi-chat-smoke smoke-model', 'model selection');
  worker.postMessage({ type: 'setModel', provider: 'pi-chat-smoke', modelId: 'smoke-model' });
  await modelSnapshot;

  for (const shellCase of [
    { command: 'PI_CHAT_USER_BASH_SMOKE included', excludeFromContext: false, output: 'USER_BASH_RESULT:included' },
    { command: 'PI_CHAT_USER_BASH_SMOKE excluded', excludeFromContext: true, output: 'USER_BASH_RESULT:excluded' },
  ]) {
    const shellStartedPromise = waitForWorkerMessage((message) => message?.type === 'run-started'
      && message.shellCommand === true && message.command === shellCase.command, 'Pi shell-command start');
    const shellOutputPromise = waitForWorkerMessage((message) => message?.type === 'bash-execution-update'
      && typeof message.delta === 'string' && message.delta.includes(shellCase.output), 'Pi shell-command output');
    const shellFinishedPromise = waitForWorkerMessage((message) => message?.type === 'run-finished'
      && message.shellCommand === true, 'Pi shell-command completion');
    const shellSnapshotPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
      && Array.isArray(message.messages)
      && message.messages.some((entry) => entry.role === 'bashExecution'
        && entry.command === shellCase.command
        && entry.output.includes(shellCase.output)
        && entry.excludeFromContext === shellCase.excludeFromContext), 'persisted Pi shell-command result');
    worker.postMessage({
      type: 'runShellCommand',
      expectedSessionPath: initializedSession.sessionFile,
      command: shellCase.command,
      excludeFromContext: shellCase.excludeFromContext,
    });
    const [shellStarted, shellOutput, shellFinished, shellSnapshot] = await Promise.all([
      shellStartedPromise,
      shellOutputPromise,
      shellFinishedPromise,
      shellSnapshotPromise,
    ]);
    assert.equal(shellStarted.canStop, true, 'Pi shell commands should expose cancellation');
    assert.equal(shellFinished.agentRun, false, 'Pi shell commands should not report an agent turn');
    assert.ok(shellOutput && shellSnapshot, 'Pi shell commands should stream output and persist the result');
  }
  const bashHookCalls = (await readFile(bashCallsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(bashHookCalls.map(({ command, excludeFromContext, cwd }) => ({ command, excludeFromContext, cwd })), [
    { command: 'PI_CHAT_USER_BASH_SMOKE included', excludeFromContext: false, cwd: projectPath },
    { command: 'PI_CHAT_USER_BASH_SMOKE excluded', excludeFromContext: true, cwd: projectPath },
  ], 'Pi shell commands should invoke the configured user_bash hook with context mode and session cwd');

  const runFinished = waitForWorkerMessage((message) => message?.type === 'run-finished', 'turn completion');
  const savedTranscriptPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && Array.isArray(message.messages)
    && message.messages.some((entry) => entry.role === 'assistant' && String(entry.text || '').includes('LOCAL_SMOKE_OK')),
  'persisted assistant reply');
  worker.postMessage({ type: 'prompt', text: 'LOCAL_SMOKE_REQUEST: reply using the local test model.' });
  const [finished, savedTranscript] = await Promise.all([runFinished, savedTranscriptPromise]);
  assert.equal(finished.aborted, false, 'the local test turn should finish without cancellation');
  assert.equal(finished.agentRun, true, 'a Pi agent-settled event should be distinguishable from other worker operations');
  assert.equal(typeof finished.sessionTitle, 'string', 'the finished event should carry only the session title needed by notification hooks');
  assert.ok(savedTranscript, 'the streamed assistant reply should be persisted in the session snapshot');
  assert.ok(assistantUpdateCount >= 2, 'the reply should reach the worker as multiple streaming updates');
  assert.ok(streamedAssistantText.includes('LOCAL_SMOKE_OK'), 'the streamed worker output should contain the local reply');
  let providerCalls = (await readFile(providerCallsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(providerCalls, [{
    kind: 'main',
    hasSmokePrompt: true,
    includedBashOutputCount: 1,
    excludedBashOutputCount: 0,
    hasCustomSystemPrompt: true,
    hasAppendedPromptText: true,
    hasAppendedPromptFile: true,
  }], 'the worker should apply bounded custom system prompt text and append configured text/files');

  const latestAssistant = savedTranscript.messages.findLast((entry) => entry.role === 'assistant' && typeof entry.entryId === 'string');
  assert.ok(latestAssistant, 'the saved assistant reply should expose an entry ID for follow-up suggestions');
  const suggestionRequestId = 'a'.repeat(24);
  const suggestionResultPromise = waitForWorkerMessage((message) => message?.type === 'prompt-suggestions-result'
    && message.requestId === suggestionRequestId, 'follow-up suggestion result');
  worker.postMessage({ type: 'suggestFollowUps', entryId: latestAssistant.entryId, requestId: suggestionRequestId });
  const suggestionResult = await suggestionResultPromise;
  assert.equal(suggestionResult.fallback, true, 'partial local model output should be identified as a fallback');
  assert.equal(suggestionResult.suggestions.length, 3, 'partial model output should be completed with usable general prompts');
  providerCalls = (await readFile(providerCallsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(providerCalls.map((call) => call.kind), ['main', 'suggestion-primary', 'suggestion-recovery'],
    'the follow-up feature should retry partial model output once through Pi’s provider runtime');

  const queueRunStartedPromise = waitForWorkerMessage((message) => message?.type === 'run-started' && message.agentRun === true,
    'managed Pi run for ordered queue operations');
  const queueBlockerStreamingPromise = waitForWorkerMessage((message) => message?.type === 'assistant-start', 'queue blocker streaming start');
  worker.postMessage({ type: 'prompt', text: `LOCAL_QUEUE_BLOCKER ${'blocker '.repeat(80)}` });
  await Promise.all([queueRunStartedPromise, queueBlockerStreamingPromise]);
  const orderedQueuePromise = waitForWorkerMessage((message) => message?.type === 'queue'
    && Array.isArray(message.operations) && message.operations.length === 3, 'three ordered queued operations');
  const queuedCompactionNoticePromise = waitForWorkerMessage((message) => message?.type === 'notice'
    && String(message.message).includes('compacted the queued session context'), 'queued Pi compaction completion');
  const queuedTranscriptPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && Array.isArray(message.messages)
    && message.messages.some((entry) => entry.role === 'assistant' && String(entry.text || '').includes('QUEUE_AFTER_COMPACTION_DONE')),
  'queued assistant reply after compaction');
  const queueRunFinishedPromise = waitForWorkerMessage((message) => message?.type === 'run-finished'
    && message.agentRun === true && message.aborted === false, 'ordered Pi queue completion');
  worker.postMessage({ type: 'prompt', text: `LOCAL_QUEUE_BEFORE_COMPACTION ${'preserve prior details '.repeat(250)}`, deliverAs: 'followUp' });
  worker.postMessage({ type: 'queueCompaction', instructions: 'Retain the exact verification goal and decisions.' });
  worker.postMessage({ type: 'prompt', text: 'LOCAL_QUEUE_AFTER_COMPACTION continue the verification.', deliverAs: 'followUp' });
  const [orderedQueue, queuedCompactionNotice, queuedTranscript, queueRunFinished] = await Promise.all([
    orderedQueuePromise,
    queuedCompactionNoticePromise,
    queuedTranscriptPromise,
    queueRunFinishedPromise,
  ]);
  assert.deepEqual(orderedQueue.operations.map((operation) => operation.type), ['prompt', 'compact', 'prompt'],
    'queued prompts and compaction should be kept in the requested order');
  assert.match(orderedQueue.operations[1].instructions, /exact verification goal/,
    'custom compaction instructions should stay attached to their queue item');
  assert.ok(queuedCompactionNotice && queuedTranscript && queueRunFinished,
    'queued compaction should finish and allow the following prompt to run');
  providerCalls = (await readFile(providerCallsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(providerCalls.map((call) => call.kind).filter((kind) => kind.startsWith('queue-') || kind === 'summarization'), [
    'queue-blocker', 'queue-before-compaction', 'summarization', 'queue-after-compaction',
  ], 'the worker should run queued prompts around compaction in order');

  const failureRunStartedPromise = waitForWorkerMessage((message) => message?.type === 'run-started' && message.agentRun === true,
    'Pi run for compaction failure recovery');
  const failureBlockerStreamingPromise = waitForWorkerMessage((message) => message?.type === 'assistant-start', 'failure blocker streaming start');
  worker.postMessage({ type: 'prompt', text: 'LOCAL_QUEUE_BLOCKER before compaction failure recovery.' });
  await Promise.all([failureRunStartedPromise, failureBlockerStreamingPromise]);
  const failedQueuePromise = waitForWorkerMessage((message) => message?.type === 'queue'
    && Array.isArray(message.operations) && message.operations.length === 2, 'compaction and prompt queued after the blocker');
  const failedCompactionNoticePromise = waitForWorkerMessage((message) => message?.type === 'notice'
    && /compaction/i.test(String(message.message)), 'queued compaction result');
  const failureTranscriptPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && Array.isArray(message.messages)
    && message.messages.some((entry) => entry.role === 'assistant' && String(entry.text || '').includes('QUEUE_AFTER_FAILURE_DONE')),
  'queued prompt after compaction failure');
  const failureRunFinishedPromise = waitForWorkerMessage((message) => message?.type === 'run-finished'
    && message.agentRun === true && message.aborted === false, 'queue completion after compaction failure');
  worker.postMessage({ type: 'queueCompaction', instructions: 'FORCE_COMPACTION_FAILURE' });
  worker.postMessage({ type: 'prompt', text: 'LOCAL_QUEUE_AFTER_FAILURE continue after the failed compaction.', deliverAs: 'followUp' });
  const [failedQueue, failedCompactionNotice, failureTranscript, failureRunFinished] = await Promise.all([
    failedQueuePromise,
    failedCompactionNoticePromise,
    failureTranscriptPromise,
    failureRunFinishedPromise,
  ]);
  assert.deepEqual(failedQueue.operations.map((operation) => operation.type), ['compact', 'prompt'],
    'a queued compaction failure should leave later queued prompts intact');
  assert.match(String(failedCompactionNotice.message), /Queued compaction failed:/,
    'the deliberately failed compaction should be reported without stopping the queue');
  assert.ok(failureTranscript && failureRunFinished,
    'the queue should report compaction failure and continue with the next prompt');
  providerCalls = (await readFile(providerCallsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(providerCalls.map((call) => call.kind).filter((kind) => kind.startsWith('queue-') || kind === 'summarization'), [
    'queue-blocker', 'queue-before-compaction', 'summarization', 'queue-after-compaction',
    'queue-blocker', 'queue-after-failure',
  ], 'the worker should continue ordered work after a compaction error');

  const sessionFile = savedTranscript.sessionFile;
  assert.equal(typeof sessionFile, 'string', 'the smoke session should expose its persisted path');
  assert.ok(resolve(sessionFile).startsWith(resolve(temporaryRoot) + sep), 'the persisted session should stay inside temporary smoke data');
  const selectedToolOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.activeTools) && message.activeTools.length === 0, 'per-session tool selection');
  worker.postMessage({ type: 'setTools', toolNames: [] });
  const selectedToolOptions = await selectedToolOptionsPromise;
  assert.deepEqual(selectedToolOptions.activeTools, [], 'an explicit per-session empty tool set should be saved');

  await worker.terminate();
  worker = undefined;
  messages.length = 0;
  worker = new Worker(workerPath, {
    env: environment,
    workerData: {
      cwd: projectPath,
      extensionRoot: repositoryRoot,
      autoNameSessions: false,
      autoRefreshModels: false,
      mcpEnabled: false,
      newSessionToolNames: ['read'],
      disabledContextFiles: [],
      disableContextFiles: true,
      piPromptResources: {
        disableSkillDiscovery: true,
        disablePromptTemplateDiscovery: true,
      },
      extensionUiMode: 'rpc',
    },
  });
  await waitForWorkerMessage((message) => message?.type === 'worker-ready', 'Pi worker restart');
  const reopenedSnapshotPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && message.sessionFile === sessionFile, 'reopened smoke session');
  const restoredToolOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.activeTools) && message.activeTools.length === 0
    && Array.isArray(message.contextFiles)
    && Array.isArray(message.skills) && message.skills.length === 0
    && Array.isArray(message.prompts) && message.prompts.length === 0,
  'restored per-session tool selection, context-file settings, and resource discovery switches');
  worker.postMessage({ type: 'openSession', path: sessionFile });
  const [, restoredToolOptions] = await Promise.all([reopenedSnapshotPromise, restoredToolOptionsPromise]);
  assert.deepEqual(restoredToolOptions.defaultTools, [], 'the session choice should not replace Pi defaults');
  assert.deepEqual(restoredToolOptions.activeTools, [], 'the saved session choice should override the new-chat default');
  assert.deepEqual(restoredToolOptions.contextFiles, [], 'disabling Pi context files should suppress AGENTS.md and CLAUDE.md discovery');
  assert.deepEqual(restoredToolOptions.skills, [], 'disabling skill discovery should suppress discovered skills and additional skill paths');
  assert.deepEqual(restoredToolOptions.prompts, [], 'disabling prompt-template discovery should suppress discovered and additional prompt paths');

  const freshSessionToolOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.activeTools) && message.activeTools.includes('read'), 'new chat tool defaults');
  worker.postMessage({ type: 'newSession', autoNameSessions: false });
  const freshSessionToolOptions = await freshSessionToolOptionsPromise;
  assert.deepEqual(freshSessionToolOptions.activeTools, ['read'], 'new chats should use the configured default tool set');

  const defaultPresetOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && message.currentModel?.id === 'smoke-model-alt' && message.thinkingLevel === 'high'
    && Array.isArray(message.activeTools) && message.activeTools.includes('read'), 'new-chat model preset');
  worker.postMessage({
    type: 'newSession',
    autoNameSessions: false,
    defaultPreset: { provider: 'pi-chat-smoke', modelId: 'smoke-model-alt', thinkingLevel: 'high' },
  });
  const defaultPresetOptions = await defaultPresetOptionsPromise;
  assert.equal(defaultPresetOptions.currentModel.id, 'smoke-model-alt', 'new chats should apply the saved preset model');
  assert.equal(defaultPresetOptions.thinkingLevel, 'high', 'new chats should apply the preset reasoning level when supported');

  const fallbackNoticePromise = waitForWorkerMessage((message) => message?.type === 'notice'
    && String(message.message).includes('default preset model is no longer available'), 'unavailable default preset fallback');
  const fallbackOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && message.currentModel?.id === 'smoke-model', 'Pi model default after preset fallback');
  worker.postMessage({
    type: 'newSession',
    autoNameSessions: false,
    defaultPreset: { provider: 'pi-chat-smoke', modelId: 'removed-smoke-model', thinkingLevel: 'high' },
  });
  const [fallbackNotice, fallbackOptions] = await Promise.all([fallbackNoticePromise, fallbackOptionsPromise]);
  assert.ok(fallbackNotice && fallbackOptions, 'an unavailable preset model should leave the new chat on Pi’s configured model default');

  console.log('Worker smoke check passed: prompt overrides, resource discovery, model selection, follow-up recovery, shell hooks, ordered prompt-compaction queues, post-compaction continuation, compaction-failure recovery, and session preference restoration.');
} finally {
  if (worker) await worker.terminate().catch(() => undefined);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (dirname(resolvedTemporaryRoot) !== resolve(tmpdir()) || !resolvedTemporaryRoot.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('Refusing to remove smoke-test data outside the system temporary directory.');
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
