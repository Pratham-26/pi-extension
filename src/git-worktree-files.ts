import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open as openFile, realpath, unlink } from 'node:fs/promises';
import * as path from 'node:path';

export type GitCommandResult = { stdout: string; stderr: string; exitCode: number };
export type IgnoredFileChoice = { label: string; description: string; relativePath: string; size: number };
export type IgnoredFileListing = { choices: IgnoredFileChoice[]; truncated: boolean };
export type GitWorktreeEntry = {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

export const MAX_IGNORED_FILES_FOR_PICKER = 500;
export const MAX_IGNORED_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_IGNORED_COPY_BYTES = 10 * 1024 * 1024;

export function runGitCommand(gitPath: string, cwd: string, args: string[], timeout: number): Promise<GitCommandResult> {
  const allowedEnvironmentKeys = new Set([
    'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedEnvironmentKeys.has(key.toUpperCase())) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return new Promise((resolve, reject) => {
    execFile(gitPath, args, {
      cwd,
      env,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        reject(error);
        return;
      }
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: error ? Number((error as NodeJS.ErrnoException).code) : 0,
      });
    });
  });
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function listGitWorktrees(gitPath: string, repositoryPath: string): Promise<GitWorktreeEntry[]> {
  const result = await runGitCommand(gitPath, repositoryPath, ['worktree', 'list', '--porcelain', '-z'], 15_000);
  if (result.exitCode !== 0) throw new Error('Git could not list worktrees.');
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;
  const finish = () => {
    if (current) entries.push(current);
    current = undefined;
  };
  for (const record of result.stdout.split('\0')) {
    if (!record) {
      finish();
      continue;
    }
    const separator = record.indexOf(' ');
    const key = separator < 0 ? record : record.slice(0, separator);
    const value = separator < 0 ? '' : record.slice(separator + 1);
    if (key === 'worktree') {
      finish();
      if (value) current = { path: value, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD' && /^[a-f0-9]{40,64}$/i.test(value)) current.head = value;
    else if (key === 'branch' && value.startsWith('refs/heads/')) current.branch = value.slice('refs/heads/'.length);
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  finish();
  return entries.filter((entry) => path.isAbsolute(entry.path) && entry.path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(entry.path));
}

export function isSafeRepositoryRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(relativePath)
    || relativePath !== relativePath.trim() || path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return false;
  const parts = relativePath.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

export async function listIgnoredFileChoices(gitPath: string, repositoryPath: string): Promise<IgnoredFileListing> {
  const result = await runGitCommand(gitPath, repositoryPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], 15_000);
  if (result.exitCode !== 0) throw new Error('Git could not list ignored workspace files.');
  const paths = [...new Set(result.stdout.split('\0').filter(isSafeRepositoryRelativePath))];
  const choices: IgnoredFileChoice[] = [];
  for (const relativePath of paths) {
    if (choices.length >= MAX_IGNORED_FILES_FOR_PICKER) break;
    const sourcePath = path.resolve(repositoryPath, relativePath);
    if (!isPathInside(repositoryPath, sourcePath)) continue;
    try {
      const stats = await lstat(sourcePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_IGNORED_FILE_BYTES) continue;
      choices.push({
        label: relativePath,
        description: `${stats.size.toLocaleString()} bytes`,
        relativePath,
        size: stats.size,
      });
    } catch {
      // Files that disappear or become inaccessible while the list is prepared are omitted.
    }
  }
  return { choices, truncated: paths.length > MAX_IGNORED_FILES_FOR_PICKER };
}

async function createSafeDestinationDirectory(rootPath: string, relativeDirectories: string[]): Promise<string> {
  let current = rootPath;
  for (const segment of relativeDirectories) {
    if (!segment || segment === '.' || segment === '..' || /[\\\u0000-\u001f\u007f]/.test(segment)) {
      throw new Error('The selected file has an unsafe destination path.');
    }
    const next = path.join(current, segment);
    try {
      const stats = await lstat(next);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('A destination folder is not a regular directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(next);
    }
    const resolved = await realpath(next);
    if (!isPathInside(rootPath, resolved)) throw new Error('A destination folder resolves outside the worktree.');
    current = resolved;
  }
  return current;
}

export async function copyIgnoredFileSafely(
  repositoryPath: string,
  worktreePath: string,
  relativePath: string,
  expectedSize: number,
  remainingBytes: number,
): Promise<'copied' | 'changed' | 'exists'> {
  if (!isSafeRepositoryRelativePath(relativePath)) throw new Error('The selected file path is invalid.');
  const sourcePath = path.resolve(repositoryPath, relativePath);
  if (!isPathInside(repositoryPath, sourcePath)) throw new Error('The selected source file is outside the repository.');
  const worktreeRoot = await realpath(worktreePath);
  const worktreeStats = await lstat(worktreePath);
  if (!worktreeStats.isDirectory() || worktreeStats.isSymbolicLink()) throw new Error('The worktree destination is not a regular folder.');

  const initialSourceStats = await lstat(sourcePath);
  if (!initialSourceStats.isFile() || initialSourceStats.isSymbolicLink() || initialSourceStats.size !== expectedSize) return 'changed';
  const noFollow = process.platform === 'win32' ? 0 : (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);
  const sourceHandle = await openFile(sourcePath, fsConstants.O_RDONLY | noFollow);
  try {
    const sourceStats = await sourceHandle.stat();
    if (!sourceStats.isFile() || sourceStats.size !== expectedSize || sourceStats.size > MAX_IGNORED_FILE_BYTES) return 'changed';
    const currentSourceStats = await lstat(sourcePath);
    if (!currentSourceStats.isFile() || currentSourceStats.isSymbolicLink()) return 'changed';
    const resolvedSourcePath = await realpath(sourcePath);
    if (!isPathInside(repositoryPath, resolvedSourcePath)) throw new Error('The selected source file resolves outside the repository.');
    if (path.relative(sourcePath, resolvedSourcePath) !== '') throw new Error('The selected source path contains a symbolic link.');

    const boundedData = Buffer.allocUnsafe(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < boundedData.length) {
      const chunk = await sourceHandle.read(boundedData, bytesRead, boundedData.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead !== expectedSize) return 'changed';
    const data = boundedData.subarray(0, bytesRead);
    if (data.byteLength > remainingBytes) throw new Error('The selected files exceed the 10 MB total copy limit.');

    const segments = relativePath.split('/');
    const fileName = segments.pop();
    if (!fileName) throw new Error('The selected file path is incomplete.');
    const destinationDirectory = await createSafeDestinationDirectory(worktreeRoot, segments);
    const destinationPath = path.join(destinationDirectory, fileName);
    const resolvedDestinationDirectory = await realpath(destinationDirectory);
    if (!isPathInside(worktreeRoot, resolvedDestinationDirectory)) throw new Error('The selected destination resolves outside the worktree.');
    let destinationHandle;
    try {
      destinationHandle = await openFile(destinationPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
    try {
      await destinationHandle.writeFile(data);
      await destinationHandle.close();
    } catch (error) {
      await destinationHandle.close().catch(() => undefined);
      await unlink(destinationPath).catch(() => undefined);
      throw error;
    }
    return 'copied';
  } finally {
    await sourceHandle.close();
  }
}
