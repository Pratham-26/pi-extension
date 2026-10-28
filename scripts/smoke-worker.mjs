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
const agentDir = join(temporaryRoot, 'agent');
const extensionDir = join(agentDir, 'extensions');
const providerCallsPath = join(temporaryRoot, 'provider-calls.jsonl');
await Promise.all([mkdir(workspacePath), mkdir(extensionDir, { recursive: true }), writeFile(providerCallsPath, '')]);

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
    models: [{ id: 'smoke-model', name: 'Local Smoke Model', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64 }],
    streamSimple(model, context) {
      const systemText = context.messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\\n');
      const userText = context.messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\\n');
      const kind = systemText.includes('Create exactly three concise') ? 'suggestion-recovery'
        : systemText.includes('Suggest three concise') ? 'suggestion-primary' : 'main';
      const text = kind === 'main' ? 'LOCAL_SMOKE_OK'
        : kind === 'suggestion-primary' ? '1. Identify one missing edge case in the implementation.'
          : '2. Suggest a focused regression test for the behavior.';
      appendFileSync(callLogPath, JSON.stringify({ kind, hasSmokePrompt: userText.includes('LOCAL_SMOKE_REQUEST') }) + '\\n', { encoding: 'utf8', mode: 0o600 });
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id, usage: usage(), stopReason: 'pending', timestamp: Date.now() };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      message.content[0].text = text;
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
      message.stopReason = 'stop';
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    },
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
        models: [{
          id: 'smoke-model',
          name: 'Local Smoke Model',
          reasoning: false,
          input: ['text'],
          contextWindow: 4096,
          maxTokens: 64,
        }],
      },
    },
  }, null, 2));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'pi-chat-smoke',
    defaultModel: 'smoke-model',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'never',
    defaultTools: [],
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
      cwd: workspacePath,
      extensionRoot: repositoryRoot,
      autoNameSessions: false,
      autoRefreshModels: false,
      mcpEnabled: false,
      newSessionToolNames: ['read'],
      disabledContextFiles: [],
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
  worker.postMessage({ type: 'initializeSession' });
  const [discoveredOptions, newSessionToolOptions] = await Promise.all([optionsPromise, newSessionToolOptionsPromise]);
  assert.equal(discoveredOptions.providers.find((provider) => provider.id === 'pi-chat-smoke')?.configured, true,
    'the temporary Pi configuration should provide a local test credential');
  assert.deepEqual(newSessionToolOptions.activeTools, ['read'], 'the configured tool set should apply to new smoke sessions');
  assert.deepEqual(newSessionToolOptions.newSessionToolNames, ['read'], 'the worker should report its configured new-chat default');

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

  const runFinished = waitForWorkerMessage((message) => message?.type === 'run-finished', 'turn completion');
  const savedTranscriptPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && Array.isArray(message.messages)
    && message.messages.some((entry) => entry.role === 'assistant' && String(entry.text || '').includes('LOCAL_SMOKE_OK')),
  'persisted assistant reply');
  worker.postMessage({ type: 'prompt', text: 'LOCAL_SMOKE_REQUEST: reply using the local test model.' });
  const [finished, savedTranscript] = await Promise.all([runFinished, savedTranscriptPromise]);
  assert.equal(finished.aborted, false, 'the local test turn should finish without cancellation');
  assert.ok(savedTranscript, 'the streamed assistant reply should be persisted in the session snapshot');
  assert.ok(assistantUpdateCount >= 2, 'the reply should reach the worker as multiple streaming updates');
  assert.ok(streamedAssistantText.includes('LOCAL_SMOKE_OK'), 'the streamed worker output should contain the local reply');
  let providerCalls = (await readFile(providerCallsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(providerCalls, [{ kind: 'main', hasSmokePrompt: true }], 'the worker should stream through the isolated in-process provider without network access');

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
      cwd: workspacePath,
      extensionRoot: repositoryRoot,
      autoNameSessions: false,
      autoRefreshModels: false,
      mcpEnabled: false,
      newSessionToolNames: ['read'],
      disabledContextFiles: [],
      extensionUiMode: 'rpc',
    },
  });
  await waitForWorkerMessage((message) => message?.type === 'worker-ready', 'Pi worker restart');
  const reopenedSnapshotPromise = waitForWorkerMessage((message) => message?.type === 'snapshot'
    && message.sessionFile === sessionFile, 'reopened smoke session');
  const restoredToolOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.activeTools) && message.activeTools.length === 0, 'restored per-session tool selection');
  worker.postMessage({ type: 'openSession', path: sessionFile });
  const [, restoredToolOptions] = await Promise.all([reopenedSnapshotPromise, restoredToolOptionsPromise]);
  assert.deepEqual(restoredToolOptions.defaultTools, [], 'the session choice should not replace Pi defaults');
  assert.deepEqual(restoredToolOptions.activeTools, [], 'the saved session choice should override the new-chat default');

  const freshSessionToolOptionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && Array.isArray(message.activeTools) && message.activeTools.includes('read'), 'new chat tool defaults');
  worker.postMessage({ type: 'newSession', autoNameSessions: false });
  const freshSessionToolOptions = await freshSessionToolOptionsPromise;
  assert.deepEqual(freshSessionToolOptions.activeTools, ['read'], 'new chats should use the configured default tool set');

  console.log('Worker smoke check passed: in-process Pi provider streamed and persisted a reply; follow-up recovery ran; session tool choices survived a restart; new-chat tool defaults applied only to new sessions.');
} finally {
  if (worker) await worker.terminate().catch(() => undefined);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (dirname(resolvedTemporaryRoot) !== resolve(tmpdir()) || !resolvedTemporaryRoot.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('Refusing to remove smoke-test data outside the system temporary directory.');
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
