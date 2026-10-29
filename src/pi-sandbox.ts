import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type GrepToolDetails,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path, { delimiter, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const MAX_HELPER_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_HELPER_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_DIAGNOSTIC_STDERR_BYTES = 64 * 1024;
const SECRET_FILE_PATTERNS = [
  '**/.env', '**/.env.*', '**/.npmrc', '**/.netrc', '**/_netrc', '**/.pypirc',
  '**/.vault-token', '**/credentials', '**/credentials.*', '**/*credentials.json',
  '**/auth.json', '**/token.json', '**/tokens.json', '**/*.token',
  '**/*.pem', '**/*.key', '**/id_rsa', '**/id_ecdsa', '**/id_ed25519', '**/.ssh/**', '**/.aws/**',
  '**/.azure/**', '**/.kube/**', '**/.config/gcloud/**', '**/secrets/**',
];

type SandboxWorkerPaths = {
  cwd: string;
  extensionRoot: string;
  helperPath: string;
  nodePath: string;
  tempRoot: string;
  tempDirectory: string;
  shellPath?: string;
};

type SandboxProcessResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  stdoutTruncated: boolean;
};

let workerPaths: SandboxWorkerPaths | undefined;
let sandboxQueue: Promise<void> = Promise.resolve();
let sandboxInitialized = false;
let sandboxInitialization: Promise<void> | undefined;

function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Sandbox domain allowlist must contain at most 128 entries.');
  const domains: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 256 || /[\u0000-\u0020\u007f]/.test(item)) {
      throw new Error('Sandbox domain allowlist contains an invalid entry.');
    }
    domains.push(item);
  }
  return [...new Set(domains)];
}

function under(parent: string, candidate: string): boolean {
  const pathModule = process.platform === 'win32' ? path.win32 : path.posix;
  const rel = pathModule.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${pathModule.sep}`) && rel !== '..' && !pathModule.isAbsolute(rel));
}

function pathEntry(path: string): { path: string; literal: true } {
  return { path, literal: true };
}

function existingDirectory(path: string | undefined): path is string {
  return Boolean(path && isAbsolute(path) && existsSync(path));
}

function findNodeExecutable(): string {
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory.replace(/^"|"$/g, ''), name);
      try {
        if (statSync(candidate).isFile()) return normalize(realpathSync(candidate));
      } catch {
        // Continue through PATH without invoking a shell.
      }
    }
  }
  throw new Error('Node.js must be available on PATH to run isolated Pi file tools.');
}

function buildSandboxConfig(paths: SandboxWorkerPaths, allowedDomains: string[]): SandboxRuntimeConfig {
  if (/[*?\[\]]/.test(paths.cwd)) {
    throw new Error('The OS sandbox cannot use a workspace path containing glob characters. Open the project from a path without *, ?, or brackets.');
  }
  const home = normalize(realpathSync(homedir()));
  if (under(paths.cwd, home)) {
    throw new Error('The OS sandbox cannot use the home directory itself as a project workspace. Open a narrower project folder.');
  }

  const systemReadRoots = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
    : process.platform === 'darwin'
      ? ['/System', '/Library', '/usr', '/bin', '/sbin']
      : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
  const readRoots = [
    paths.cwd,
    paths.extensionRoot,
    paths.helperPath,
    paths.nodePath,
    dirname(paths.nodePath),
    paths.tempRoot,
    paths.tempDirectory,
    paths.shellPath,
    ...systemReadRoots.filter(existingDirectory),
  ].filter((value): value is string => typeof value === 'string' && isAbsolute(value) && existsSync(value));

  const writeRoots = [paths.cwd, paths.tempRoot, paths.tempDirectory];
  const sharedTempDenyPaths = process.platform === 'win32'
    ? []
    : ['/tmp/claude', '/private/tmp/claude'];
  const credentialPaths = SECRET_FILE_PATTERNS.map((pattern) => ({
    path: join(paths.cwd, ...pattern.split('/')),
    mode: 'deny' as const,
  }));

  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
    },
    filesystem: {
      denyRead: [pathEntry(home), ...sharedTempDenyPaths.map(pathEntry)],
      allowRead: [...new Set(readRoots)].map(pathEntry),
      allowWrite: [...new Set(writeRoots)].map(pathEntry),
      denyWrite: sharedTempDenyPaths.map(pathEntry),
      allowGitConfig: false,
    },
    credentials: {
      files: credentialPaths,
    },
    ...(process.platform === 'win32'
      ? {
        windows: {
          srtWin: {
            path: join(paths.extensionRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'vendor', 'srt-win', process.arch === 'arm64' ? 'arm64' : 'x64', 'srt-win.exe'),
          },
        },
      }
      : {}),
  };
}

function makePrivateEnvironment(cwd: string, tempDirectory: string, shellEnvironment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = shellEnvironment ?? {};
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'NO_COLOR', 'CI']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length <= 32_768) env[key] = value;
  }
  env.HOME = tempDirectory;
  env.USERPROFILE = tempDirectory;
  env.TMPDIR = tempDirectory;
  env.TMP = tempDirectory;
  env.TEMP = tempDirectory;
  env.PWD = cwd;
  for (const key of ['PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) {
    const value = source[key];
    if (typeof value === 'string' && value.length <= 256) env[key] = value;
  }
  return env;
}

function withSandboxLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = sandboxQueue;
  let release!: () => void;
  sandboxQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  return previous.then(task).finally(release);
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function processTreeKill(child: ChildProcess, force = false): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Process already exited. */ }
  }
}

async function runWrappedProcess(options: {
  command: string;
  cwd: string;
  shellPath?: string;
  stdin?: Buffer;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  captureStdout?: boolean;
  onData?: (data: Buffer) => void;
  commandText: string;
}): Promise<SandboxProcessResult> {
  const state = workerPaths;
  if (!state || !sandboxInitialized) throw new Error('The OS sandbox is not initialized.');
  if (options.signal?.aborted) throw new Error('aborted');
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
    throw new Error('Invalid command timeout.');
  }
  const commandId = randomUUID();
  let wrapped;
  try {
    wrapped = await SandboxManager.wrapWithSandboxArgv(
      options.command,
      options.shellPath,
      undefined,
      options.signal,
      options.cwd,
      { commandId, commandText: options.commandText },
    );
  } catch (error) {
    try { SandboxManager.cleanupAfterCommand(); } catch { /* Keep the wrapper error. */ }
    throw new Error(error instanceof Error ? error.message : 'Could not prepare the OS sandbox.');
  }

  // Windows launches the command through a trusted broker. The runtime returns
  // the broker's required environment, while its child starts from a fresh
  // sandbox profile and receives only the configured overlay. On POSIX the
  // wrapped command runs directly, so inherit only the explicit allowlist.
  const childEnv = process.platform === 'win32'
    ? wrapped.env
    : makePrivateEnvironment(options.cwd, state.tempDirectory, options.env);
  const args = wrapped.argv.slice(1);
  const executable = wrapped.argv[0];
  if (!executable || args.some((argument) => typeof argument !== 'string')) {
    SandboxManager.cleanupAfterCommand();
    throw new Error('The OS sandbox returned an invalid process command.');
  }
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    SandboxManager.cleanupAfterCommand();
    throw error;
  }

  const outputChunks: Buffer[] = [];
  let outputBytes = 0;
  let stdoutTruncated = false;
  let diagnosticStderr = '';
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let callbackError: Error | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let escalationHandle: NodeJS.Timeout | undefined;
  let closeResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let closeReject!: (error: Error) => void;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    closeResolve = resolveClose;
    closeReject = rejectClose;
  });
  const onAbort = () => {
    aborted = true;
    processTreeKill(child);
    escalationHandle = setTimeout(() => processTreeKill(child, true), 1000);
    escalationHandle.unref?.();
  };
  const terminate = () => {
    processTreeKill(child);
    escalationHandle = setTimeout(() => processTreeKill(child, true), 1000);
    escalationHandle.unref?.();
  };
  const notifyData = (data: Buffer) => {
    try {
      options.onData?.(data);
    } catch (error) {
      callbackError ??= error instanceof Error ? error : new Error('The Pi tool output callback failed.');
      terminate();
    }
  };
  const onData = (chunk: Buffer) => {
    notifyData(chunk);
    if (options.captureStdout) {
      const remaining = MAX_HELPER_RESPONSE_BYTES - outputBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        outputChunks.push(retained);
        outputBytes += retained.length;
      }
      if (chunk.length > remaining) {
        stdoutTruncated = true;
        terminate();
      }
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    notifyData(data);
    const remaining = MAX_DIAGNOSTIC_STDERR_BYTES - Buffer.byteLength(diagnosticStderr, 'utf8');
    if (remaining > 0) diagnosticStderr += data.toString('utf8').slice(0, remaining);
  });
  child.once('error', (error) => closeReject(error));
  child.stdout?.once('error', (error) => closeReject(error));
  child.stderr?.once('error', (error) => closeReject(error));
  child.stdin?.once('error', (error) => {
    callbackError ??= error;
    terminate();
  });
  child.once('close', (code, signal) => closeResolve({ code, signal }));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  if (options.timeout !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.min(options.timeout, 2_147_483_647));
    timeoutHandle.unref?.();
  }
  try {
    if (options.stdin) child.stdin?.end(options.stdin);
    else child.stdin?.end();
    const result = await closed;
    settled = true;
    const annotatedStderr = SandboxManager.annotateStderrWithSandboxFailures(commandId, diagnosticStderr);
    if (annotatedStderr && annotatedStderr !== diagnosticStderr) {
      const addition = annotatedStderr.slice(diagnosticStderr.length);
      if (addition) notifyData(Buffer.from(addition, 'utf8'));
    }
    if (options.signal?.aborted || aborted) throw new Error('aborted');
    if (timedOut) throw new Error('timeout');
    if (callbackError) throw callbackError;
    const exitCode = result.code ?? (result.signal ? 1 : 0);
    return {
      exitCode,
      stdout: Buffer.concat(outputChunks),
      stderr: annotatedStderr,
      stdoutTruncated,
    };
  } finally {
    if (!settled) terminate();
    options.signal?.removeEventListener('abort', onAbort);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (escalationHandle) clearTimeout(escalationHandle);
    SandboxManager.cleanupAfterCommand();
  }
}

async function runSandboxHelper(action: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<any> {
  const state = workerPaths;
  if (!state || !sandboxInitialized) throw new Error('The OS sandbox is not initialized.');
  const request = JSON.stringify({ action, ...args });
  const requestBuffer = Buffer.from(request, 'utf8');
  if (requestBuffer.length > MAX_HELPER_REQUEST_BYTES) throw new Error('The sandboxed file request is too large.');
  return withSandboxLock(async () => {
    const command = process.platform === 'win32'
      ? `& ${quotePowerShell(state.nodePath)} ${quotePowerShell(state.helperPath)}`
      : `${quotePosix(state.nodePath)} ${quotePosix(state.helperPath)}`;
    const result = await runWrappedProcess({
      command,
      cwd: state.cwd,
      shellPath: process.platform === 'win32' ? 'powershell' : '/bin/sh',
      stdin: requestBuffer,
      signal: options.signal,
      timeout: options.timeoutMs ?? 20_000,
      captureStdout: true,
      commandText: `Pi built-in ${action} operation`,
    });
    if (result.stdoutTruncated) throw new Error('Sandbox helper returned too much data.');
    let response: { ok?: boolean; result?: unknown; error?: string };
    try {
      response = JSON.parse(result.stdout.toString('utf8')) as typeof response;
    } catch {
      throw new Error(result.stderr || 'The sandboxed Pi file operation returned invalid data.');
    }
    if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : 'The sandboxed Pi file operation failed.');
    if (result.exitCode !== 0) throw new Error(typeof response.error === 'string' ? response.error : 'The sandboxed Pi file operation failed.');
    return response.result;
  });
}

function makeShellOperations(shellPath?: string, prefix = ''): BashOperations {
  return {
    exec: (command, cwd, options) => withSandboxLock(async () => {
      const result = await runWrappedProcess({
        command: `${prefix}${command}`,
        cwd,
        shellPath,
        signal: options.signal,
        timeout: options.timeout,
        env: options.env,
        onData: options.onData,
        commandText: 'Pi built-in shell command',
      });
      return { exitCode: result.exitCode };
    }),
  };
}

function createSandboxedTools(
  cwd: string,
  bashOperations: BashOperations,
  shellPath?: string,
  commandPrefix?: string,
): ToolDefinition<any, any, any>[] {
  const readOperations: ReadOperations = {
    readFile: async (absolutePath) => {
      const result = await runSandboxHelper('readFile', { path: absolutePath });
      if (!result || typeof result.base64 !== 'string') throw new Error('The sandboxed read tool returned invalid data.');
      return Buffer.from(result.base64, 'base64');
    },
    access: async (absolutePath) => { await runSandboxHelper('access', { path: absolutePath }); },
    detectImageMimeType: async (absolutePath) => {
      const result = await runSandboxHelper('imageMime', { path: absolutePath });
      return typeof result?.mimeType === 'string' ? result.mimeType : null;
    },
  };
  const writeOperations: WriteOperations = {
    writeFile: async (absolutePath, content) => { await runSandboxHelper('writeFile', { path: absolutePath, content }); },
    mkdir: async (directory) => { await runSandboxHelper('mkdir', { path: directory }); },
  };
  const editOperations: EditOperations = {
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
    access: readOperations.access,
  };
  const lsOperations: LsOperations = {
    exists: async (absolutePath) => (await runSandboxHelper('exists', { path: absolutePath })).exists === true,
    stat: async (absolutePath) => {
      const info = await runSandboxHelper('stat', { path: absolutePath });
      return { isDirectory: () => info?.isDirectory === true };
    },
    readdir: async (absolutePath) => {
      const result = await runSandboxHelper('readdir', { path: absolutePath });
      return Array.isArray(result?.entries) ? result.entries.filter((entry: unknown): entry is string => typeof entry === 'string') : [];
    },
  };
  const findOperations: FindOperations = {
    exists: lsOperations.exists,
    glob: async (pattern, root, options) => {
      const result = await runSandboxHelper('glob', { path: root, pattern, ignore: options.ignore, limit: options.limit });
      return Array.isArray(result?.paths) ? result.paths.filter((entry: unknown): entry is string => typeof entry === 'string') : [];
    },
  };

  const grepDefinition = createGrepToolDefinition(cwd);
  const sandboxedGrep: typeof grepDefinition = {
    ...grepDefinition,
    execute: async (_toolCallId, input, signal): Promise<{ content: Array<{ type: 'text'; text: string }>; details: GrepToolDetails | undefined }> => {
      const root = resolve(cwd, input.path ?? '.');
      const result = await runSandboxHelper('grep', {
        path: root,
        pattern: input.pattern,
        glob: input.glob,
        ignoreCase: input.ignoreCase,
        literal: input.literal,
        context: input.context,
        limit: input.limit,
      }, { signal });
      const matches = Array.isArray(result?.matches) ? result.matches : [];
      if (matches.length === 0) return { content: [{ type: 'text', text: 'No matches found' }], details: undefined };
      const rootIsDirectory = await runSandboxHelper('stat', { path: root }).then((info) => info?.isDirectory === true).catch(() => false);
      const output: string[] = [];
      for (const match of matches) {
        if (!match || typeof match.path !== 'string' || typeof match.lineNumber !== 'number') continue;
        const rel = rootIsDirectory ? relative(root, match.path).split(sep).join('/') : parse(match.path).base;
        if (Array.isArray(match.lines) && typeof match.firstLine === 'number') {
          for (let index = 0; index < match.lines.length; index++) {
            const lineNumber = match.firstLine + index;
            const text = String(match.lines[index] ?? '').replace(/\r/g, '');
            output.push(lineNumber === match.lineNumber ? `${rel}:${lineNumber}: ${text}` : `${rel}-${lineNumber}- ${text}`);
          }
        } else {
          output.push(`${rel}:${match.lineNumber}: ${String(match.lineText ?? '').replace(/\r/g, '')}`);
        }
      }
      let text = output.join('\n');
      const maxOutputChars = 200_000;
      const wasTruncated = text.length > maxOutputChars;
      if (wasTruncated) text = `${text.slice(0, maxOutputChars)}\n\n[${formatSize(Buffer.byteLength(text, 'utf8') - Buffer.byteLength(text.slice(0, maxOutputChars), 'utf8'))} omitted]`;
      const details: GrepToolDetails = {};
      if (result?.truncated === true) details.matchLimitReached = input.limit ?? 100;
      if (wasTruncated) details.linesTruncated = true;
      return { content: [{ type: 'text', text }], details: Object.keys(details).length > 0 ? details : undefined };
    },
  };

  return [
    createReadToolDefinition(cwd, { operations: readOperations }),
    createBashToolDefinition(cwd, { operations: bashOperations, shellPath, commandPrefix }),
    createEditToolDefinition(cwd, { operations: editOperations }),
    createWriteToolDefinition(cwd, { operations: writeOperations }),
    sandboxedGrep,
    createFindToolDefinition(cwd, { operations: findOperations }),
    createLsToolDefinition(cwd, { operations: lsOperations }),
    createPowerShellToolDefinition(cwd, {
      operations: makeShellOperations(process.platform === 'win32' ? 'powershell' : undefined,
        process.platform === 'win32' ? 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {};\n' : ''),
    }),
  ] as ToolDefinition<any, any, any>[];
}

export async function initializePiOsSandbox(options: {
  cwd: string;
  extensionRoot: string;
  shellPath?: string;
  allowedDomains: unknown;
}): Promise<void> {
  if (sandboxInitialized) return;
  if (sandboxInitialization) return sandboxInitialization;
  sandboxInitialization = (async () => {
    const cwd = normalize(realpathSync(options.cwd));
    const extensionRoot = normalize(realpathSync(options.extensionRoot));
    const helperPath = join(extensionRoot, 'dist', 'pi-sandbox-helper.cjs');
    const nodePath = findNodeExecutable();
    await access(helperPath);
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-chat-os-sandbox-'));
    const tempDirectory = join(tempRoot, 'tmp');
    try {
      await mkdir(tempDirectory, { recursive: true });
      workerPaths = { cwd, extensionRoot, helperPath, nodePath, tempRoot, tempDirectory, shellPath: options.shellPath };
      const config = buildSandboxConfig(workerPaths, normalizeDomainList(options.allowedDomains));
      await SandboxManager.initialize(config, undefined, process.platform === 'darwin' || process.platform === 'linux');
      sandboxInitialized = true;
    } catch (error) {
      workerPaths = undefined;
      try { await SandboxManager.reset(); } catch { /* Best-effort cleanup after failed initialization. */ }
      try { await rm(tempRoot, { recursive: true, force: true, maxRetries: 2 }); } catch { /* Keep the original initialization failure. */ }
      if (process.platform === 'win32') {
        const configPath = join(extensionRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'vendor', 'srt-win', process.arch === 'arm64' ? 'arm64' : 'x64', 'srt-win.exe');
        if (!existsSync(configPath)) throw new Error('The bundled Windows sandbox helper is missing from this extension install. Reinstall the extension package.');
        const detail = error instanceof Error ? error.message : 'Sandbox initialization failed.';
        if (/not_provisioned|not provisioned|Windows sandbox user/i.test(detail)) {
          throw new Error('The OS sandbox is not set up. In an elevated terminal, run `npx --yes --package=@anthropic-ai/sandbox-runtime@0.0.81 srt windows-install --skip-profile-grant`, then restart Pi. The extension does not run this machine-level setup automatically.');
        }
      }
      throw error;
    } finally {
      sandboxInitialization = undefined;
    }
  })();
  return sandboxInitialization;
}

export function createPiOsSandboxTools(cwd: string, shellPath?: string, commandPrefix?: string): ToolDefinition<any, any, any>[] {
  if (!sandboxInitialized) throw new Error('The OS sandbox must be initialized before creating its Pi tools.');
  return createSandboxedTools(cwd, makeShellOperations(shellPath), shellPath, commandPrefix);
}

export function createPiOsSandboxBashOperations(shellPath?: string): BashOperations {
  if (!sandboxInitialized) throw new Error('The OS sandbox must be initialized before running shell commands.');
  return makeShellOperations(shellPath);
}

export async function disposePiOsSandbox(): Promise<void> {
  if (!sandboxInitialized && !workerPaths) return;
  await withSandboxLock(async () => {
    const state = workerPaths;
    sandboxInitialized = false;
    workerPaths = undefined;
    try { await SandboxManager.reset(); } finally {
      if (state) {
        try { await rm(state.tempRoot, { recursive: true, force: true, maxRetries: 2 }); } catch { /* OS will remove a temporary directory on reboot. */ }
      }
    }
  });
}
