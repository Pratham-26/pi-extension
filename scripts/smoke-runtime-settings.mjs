import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(repositoryRoot, 'dist', 'pi-worker.mjs');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pi-chat-runtime-settings-'));
const workspacePath = join(temporaryRoot, 'workspace');
const agentDir = join(temporaryRoot, 'agent');
await Promise.all([mkdir(workspacePath), mkdir(agentDir)]);

let worker;

function waitForWorkerMessage(predicate, label, timeoutMs = 10_000) {
  return new Promise((resolveMessage, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      if (error) reject(error);
      else resolveMessage(message);
    };
    const onMessage = (message) => {
      if (message?.type === 'runtime-error') {
        finish(new Error(message.message || `Pi worker failed while waiting for ${label}.`));
      } else if (predicate(message)) {
        finish(undefined, message);
      }
    };
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    worker.on('message', onMessage);
    worker.once('error', onError);
  });
}

try {
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'pi-chat-settings-smoke': {
        name: 'Pi Chat Runtime Settings Smoke',
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
        apiKey: 'unused-runtime-settings-key',
        models: [{ id: 'settings-smoke-model', contextWindow: 4096, maxTokens: 64 }],
      },
    },
  }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'pi-chat-settings-smoke',
    defaultModel: 'settings-smoke-model',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'never',
    defaultTools: [],
  }));

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
      newSessionToolNames: [],
      disabledContextFiles: [],
      extensionUiMode: 'rpc',
    },
  });

  await waitForWorkerMessage((message) => message?.type === 'worker-ready', 'Pi worker startup');
  const optionsPromise = waitForWorkerMessage((message) => message?.type === 'options'
    && message.runtimeSettings?.steeringMode === 'one-at-a-time'
    && message.runtimeSettings?.followUpMode === 'one-at-a-time', 'runtime settings discovery');
  worker.postMessage({ type: 'initializeSession' });
  const options = await optionsPromise;
  assert.equal(options.runtimeSettings.hideThinkingBlock, false, 'thinking should be visible by default');
  assert.equal(options.runtimeSettings.showCacheMissNotices, false, 'cache-miss notices should be off by default');
  assert.equal(options.runtimeSettings.sessionShareDestination, 'auto', 'the share destination should default to automatic');

  const changes = [
    ['steeringMode', 'all'],
    ['followUpMode', 'all'],
    ['hideThinkingBlock', true],
    ['showCacheMissNotices', true],
    ['sessionShareDestination', 'radius'],
  ];
  for (const [setting, value] of changes) {
    const expectedOptions = waitForWorkerMessage((message) => message?.type === 'options'
      && message.runtimeSettings?.[setting] === value, `Pi setting ${setting}`);
    worker.postMessage({ type: 'updatePiSetting', setting, value });
    await expectedOptions;
  }

  const persisted = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(persisted.steeringMode, 'all', 'steering mode should persist through Pi’s settings manager');
  assert.equal(persisted.followUpMode, 'all', 'follow-up mode should persist through Pi’s settings manager');
  assert.equal(persisted.hideThinkingBlock, true, 'thinking visibility should persist through Pi’s settings manager');
  assert.equal(persisted.showCacheMissNotices, true, 'cache-miss notice preference should persist through Pi’s settings manager');
  assert.equal(persisted.sessionShareDestination, 'radius', 'share destination should persist through Pi’s settings manager');

  const invalidSetting = waitForWorkerMessage((message) => message?.type === 'notice'
    && message.isError === true && String(message.message).includes('unavailable or invalid'), 'invalid Pi setting rejection');
  worker.postMessage({ type: 'updatePiSetting', setting: 'sessionShareDestination', value: 'javascript:invalid' });
  await invalidSetting;
  const unchanged = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(unchanged.sessionShareDestination, 'radius', 'invalid setting values must not reach Pi settings.json');

  console.log('Runtime settings smoke check passed: five allowlisted Pi preferences were reported, saved, and read back; an invalid value was rejected without changing settings.json.');
} finally {
  if (worker) await worker.terminate().catch(() => undefined);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (dirname(resolvedTemporaryRoot) !== resolve(tmpdir())) {
    throw new Error('Refusing to remove smoke-test data outside the system temporary directory.');
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
