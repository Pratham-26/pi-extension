import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export type NotificationHookEvent = 'input_request' | 'agent_finished';

export type NotificationHookPayload = {
  event: NotificationHookEvent;
  title: string;
  message: string;
  sessionPath: string;
};

export type NotificationHookResult = {
  success: boolean;
  reason: 'completed' | 'not-started' | 'stdin-failed' | 'timed-out' | 'exit-failed' | 'concurrency-limit';
  exitCode?: number | null;
  durationMs: number;
};

export type NotificationHookRunnerOptions = {
  spawnProcess?: typeof spawnChild;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
};

const MAX_COMMAND_CHARS = 4096;
const MAX_ENV_CHARS = 32 * 1024;
const HOOK_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_HOOKS = 16;
const SAFE_ENVIRONMENT_NAMES = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);

let activeHookCount = 0;

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = environment[name];
  if (direct) return direct;
  const normalizedName = name.toUpperCase();
  const matching = Object.keys(environment).find((key) => key.toUpperCase() === normalizedName);
  return matching ? environment[matching] : undefined;
}

function cleanHookText(value: unknown, maximumChars: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximumChars)
    : '';
}

export function normalizeNotificationHookCommand(value: unknown): string {
  return typeof value === 'string'
    && value.length <= MAX_COMMAND_CHARS
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : '';
}

export function normalizeNotificationHookEvents(value: unknown): NotificationHookEvent[] {
  if (!Array.isArray(value)) return ['input_request'];
  return [...new Set(value.filter((event): event is NotificationHookEvent =>
    event === 'input_request' || event === 'agent_finished'))];
}

export function buildNotificationHookEnvironment(
  payload: NotificationHookPayload,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let remaining = MAX_ENV_CHARS - 5_000;
  const platformKey = (key: string) => platform === 'win32' ? key.toUpperCase() : key;
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (typeof value !== 'string' || !value || value.length > remaining) continue;
    const normalizedKey = platformKey(key);
    const isBasicEnvironment = SAFE_ENVIRONMENT_NAMES.has(normalizedKey)
      || /^LC_[A-Z0-9_]{1,64}$/i.test(key);
    const isExplicitHookEnvironment = /^PI_CHAT_HOOK_[A-Z0-9_]{1,120}$/i.test(key);
    if (!isBasicEnvironment && !isExplicitHookEnvironment) continue;
    env[key] = value;
    remaining -= key.length + value.length;
    if (remaining <= 0) break;
  }

  env.PI_CHAT_EVENT = payload.event;
  env.PI_CHAT_TITLE = cleanHookText(payload.title, 128);
  env.PI_CHAT_MESSAGE = cleanHookText(payload.message, 512);
  env.PI_CHAT_SESSION_PATH = cleanHookText(payload.sessionPath, 4096);
  return env;
}

function stopChild(child: ChildProcess, env: NodeJS.ProcessEnv, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* The process group may already have exited. */ }
  }
  if (process.platform === 'win32' && child.pid) {
    const systemRoot = environmentValue(env, 'SystemRoot') || environmentValue(env, 'WINDIR') || 'C:\\Windows';
    const taskkillPath = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    try {
      const treeKiller = spawnChild(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
        env,
        stdio: 'ignore',
        windowsHide: true,
      });
      treeKiller.once('error', () => {
        try { child.kill(signal); } catch { /* A process may already have exited. */ }
      });
      treeKiller.once('close', (code) => {
        if (code !== 0) {
          try { child.kill(signal); } catch { /* A process may already have exited. */ }
        }
      });
      treeKiller.unref();
      return;
    } catch { /* Fall back to stopping the shell process below. */ }
  }
  try { child.kill(signal); } catch { /* A process may already have exited. */ }
}

export function runNotificationHook(
  command: string,
  payload: NotificationHookPayload,
  options: NotificationHookRunnerOptions = {},
): Promise<NotificationHookResult> {
  const safeCommand = normalizeNotificationHookCommand(command);
  if (!safeCommand) {
    return Promise.resolve({ success: false, reason: 'not-started', durationMs: 0 });
  }
  if (activeHookCount >= MAX_CONCURRENT_HOOKS) {
    return Promise.resolve({ success: false, reason: 'concurrency-limit', durationMs: 0 });
  }

  const input = JSON.stringify({
    event: payload.event,
    title: cleanHookText(payload.title, 128),
    message: cleanHookText(payload.message, 512),
    sessionPath: cleanHookText(payload.sessionPath, 4096),
  });
  const platform = options.platform ?? process.platform;
  const env = buildNotificationHookEnvironment(payload, options.environment ?? process.env, platform);
  const startedAt = Date.now();
  activeHookCount++;

  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let stdinFailed = false;
    let hardStopTimer: NodeJS.Timeout | undefined;
    const timeoutMs = Math.min(HOOK_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? HOOK_TIMEOUT_MS));
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild(child, env, 'SIGKILL');
      hardStopTimer = setTimeout(() => finish(null), 1000);
      hardStopTimer.unref?.();
    }, HOOK_TIMEOUT_MS);
    timeout.unref?.();

    const finish = (exitCode: number | null, startFailed = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      activeHookCount = Math.max(0, activeHookCount - 1);
      const durationMs = Math.max(0, Date.now() - startedAt);
      const reason = timedOut
        ? 'timed-out'
        : startFailed
          ? 'not-started'
          : stdinFailed
            ? 'stdin-failed'
            : exitCode === 0 ? 'completed' : 'exit-failed';
      resolve({ success: reason === 'completed', reason, exitCode, durationMs });
    };

    const systemRoot = environmentValue(env, 'SystemRoot') || environmentValue(env, 'WINDIR') || 'C:\\Windows';
    const shell = platform === 'win32'
      ? path.win32.join(systemRoot, 'System32', 'cmd.exe')
      : '/bin/sh';
    const spawnProcess = options.spawnProcess ?? spawnChild;
    let child: ChildProcess;
    try {
      child = spawnProcess(shell, platform === 'win32' ? ['/d', '/s', '/c', safeCommand] : ['-c', safeCommand], {
        env,
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      finish(null, true);
      return;
    }

    child.once('error', () => finish(null, true));
    child.once('close', (code) => finish(typeof code === 'number' ? code : null));
    child.stdin?.once('error', () => {
      stdinFailed = true;
      stopChild(child, env);
    });
    try {
      if (!child.stdin) {
        stdinFailed = true;
        stopChild(child, env);
      } else {
        child.stdin.end(input);
      }
    } catch {
      stdinFailed = true;
      stopChild(child, env);
    }
  });
}
