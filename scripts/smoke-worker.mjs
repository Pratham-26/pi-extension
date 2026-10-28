import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(repositoryRoot, 'dist', 'pi-worker.mjs');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pi-chat-worker-smoke-'));
const workspacePath = join(temporaryRoot, 'workspace');
const agentDir = join(temporaryRoot, 'agent');
await Promise.all([mkdir(workspacePath), mkdir(agentDir)]);

let requestCount = 0;
let requestAuth = '';
let requestPath = '';
let requestModel = '';
let requestStream;
let server;
let worker;
const messages = [];
let streamedAssistantText = '';
let assistantUpdateCount = 0;

function respondJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Mock model request exceeded the smoke-test size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function openAiCompletion(model, content) {
  return {
    id: 'chatcmpl-local-smoke',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

async function handleModelRequest(request, response) {
  requestCount += 1;
  requestAuth = String(request.headers.authorization || '');
  requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  if (request.method !== 'POST' || !requestPath.endsWith('/chat/completions')) {
    respondJson(response, 404, { error: { message: 'Unexpected local smoke-test route.' } });
    return;
  }
  if (requestAuth !== 'Bearer pi-chat-local-smoke-key') {
    respondJson(response, 401, { error: { message: 'Unexpected local smoke-test credential.' } });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch {
    respondJson(response, 400, { error: { message: 'Invalid local smoke-test request.' } });
    return;
  }
  requestModel = typeof body.model === 'string' ? body.model : '';
  requestStream = body.stream;
  if (!Array.isArray(body.messages) || !JSON.stringify(body.messages).includes('LOCAL_SMOKE_REQUEST')) {
    respondJson(response, 400, { error: { message: 'The prompt did not reach the local model.' } });
    return;
  }

  const model = requestModel || 'smoke-model';
  if (body.stream !== true) {
    respondJson(response, 200, openAiCompletion(model, 'LOCAL_SMOKE_OK'));
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const sendChunk = (delta, finishReason = null, usage) => {
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-local-smoke',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    })}\n\n`);
  };
  sendChunk({ role: 'assistant', content: 'LOCAL_' });
  sendChunk({ content: 'SMOKE_OK' });
  sendChunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  response.write('data: [DONE]\n\n');
  response.end();
}

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
      finish(new Error(`Timed out waiting for ${label}. Local model requests: ${requestCount}; route: ${requestPath || 'none'}; streaming: ${String(requestStream)}; model: ${requestModel || 'none'}; assistant updates: ${assistantUpdateCount}; output: ${streamedAssistantText.slice(0, 120)}; auth header: ${requestAuth ? 'received' : 'not received'}. Recent worker events: ${recentEvents || '(none)'}.`));
    }, timeoutMs);
    worker.on('message', onMessage);
    worker.once('error', onError);
  });
}

try {
  server = createServer((request, response) => {
    void handleModelRequest(request, response).catch(() => {
      if (!response.headersSent) respondJson(response, 500, { error: { message: 'Local smoke model failed.' } });
      else response.destroy();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object' && Number.isInteger(address.port), 'local mock endpoint should bind to loopback');

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'pi-chat-smoke': {
        name: 'Pi Chat Local Smoke',
        baseUrl,
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
  assert.equal(requestCount, 1, 'the test should make exactly one request to its loopback model');
  assert.equal(requestAuth, 'Bearer pi-chat-local-smoke-key', 'the configured model credential should reach only the local endpoint');
  assert.equal(requestStream, true, 'the worker should request a streaming model response');
  assert.equal(requestModel, 'smoke-model', 'the selected Pi model should reach the local endpoint');

  const latestAssistant = savedTranscript.messages.findLast((entry) => entry.role === 'assistant' && typeof entry.entryId === 'string');
  assert.ok(latestAssistant, 'the saved assistant reply should expose an entry ID for follow-up suggestions');
  const suggestionRequestId = 'a'.repeat(24);
  const suggestionResultPromise = waitForWorkerMessage((message) => message?.type === 'prompt-suggestions-result'
    && message.requestId === suggestionRequestId, 'follow-up suggestion result');
  worker.postMessage({ type: 'suggestFollowUps', entryId: latestAssistant.entryId, requestId: suggestionRequestId });
  const suggestionResult = await suggestionResultPromise;
  assert.equal(suggestionResult.fallback, true, 'malformed local model output should be identified as a fallback');
  assert.equal(suggestionResult.suggestions.length, 3, 'partial model output should be completed with usable general prompts');
  assert.equal(requestCount, 3, 'follow-up generation should make a primary request and one recovery request');

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

  console.log('Worker smoke check passed: assistant reply streamed and persisted; session tool choices survived a restart; new-chat tool defaults applied only to new sessions.');
} finally {
  if (worker) await worker.terminate().catch(() => undefined);
  if (server) await new Promise((resolveClose) => server.close(() => resolveClose()));
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (dirname(resolvedTemporaryRoot) !== resolve(tmpdir()) || !resolvedTemporaryRoot.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('Refusing to remove smoke-test data outside the system temporary directory.');
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
