import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open as openFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeTurnFilePath, isSensitiveTurnFilePath } from './turn-file-summary';

export type TurnUndoSnapshot = {
  exists: boolean;
  content?: string;
  omittedReason?: string;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
  mode?: number;
};

export type TurnUndoGitFile = {
  path: string;
  repositoryPath: string;
  status: string[];
  untracked: boolean;
  snapshot?: TurnUndoSnapshot;
};

export type TurnUndoExpectedState = {
  exists: boolean;
  contentHash?: string;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
  mode?: number;
};

export type TurnUndoAction = {
  kind: 'restore-content' | 'restore-head' | 'trash-created';
  path: string;
  repositoryPath: string;
  expected: TurnUndoExpectedState;
  beforeContent?: string;
  beforeMode?: number;
  headCommit?: string;
};

export function createTurnUndoAction(input: {
  before?: TurnUndoGitFile;
  after?: TurnUndoGitFile;
  afterSnapshot: TurnUndoSnapshot;
  baselineHead?: string;
  currentHead?: string;
  baselineTruncated: boolean;
  currentTruncated: boolean;
}): TurnUndoAction | undefined {
  const { before, after, afterSnapshot } = input;
  const current = after ?? before;
  if (!current || input.baselineTruncated || input.currentTruncated
    || input.baselineHead !== input.currentHead
    || !isSafeTurnFilePath(current.path) || !isSafeTurnFilePath(current.repositoryPath)
    || isSensitiveTurnFilePath(current.path)
    || hasUnsafeGitState(before) || hasUnsafeGitState(after)
    || (afterSnapshot.exists && (afterSnapshot.content === undefined || afterSnapshot.omittedReason))) return undefined;

  const expected = expectedState(afterSnapshot);
  if (before) {
    const previous = before.snapshot;
    if (!previous || previous.omittedReason) return undefined;
    if (!previous.exists) {
      // A file deleted before the run must remain absent after Undo, even if
      // Pi recreated it. Move the recreated regular file to Trash.
      return afterSnapshot.exists ? {
        kind: 'trash-created', path: current.path, repositoryPath: current.repositoryPath,
        expected,
      } : undefined;
    }
    if (previous.content === undefined || previous.mode === undefined || (previous.mode & 0o7000) !== 0) return undefined;
    return {
      kind: 'restore-content',
      path: current.path,
      repositoryPath: current.repositoryPath,
      expected,
      beforeContent: previous.content,
      beforeMode: previous.mode,
    };
  }

  if (!after) return undefined;
  if (after.untracked) {
    return afterSnapshot.exists
      ? { kind: 'trash-created', path: after.path, repositoryPath: after.repositoryPath, expected }
      : undefined;
  }
  if (!input.baselineHead || input.currentHead !== input.baselineHead) return undefined;
  return {
    kind: 'restore-head',
    path: after.path,
    repositoryPath: after.repositoryPath,
    expected,
    headCommit: input.baselineHead,
  };
}

export function turnUndoSnapshotMatches(snapshot: TurnUndoSnapshot, expected: TurnUndoExpectedState): boolean {
  if (snapshot.exists !== expected.exists || snapshot.omittedReason) return false;
  if (!expected.exists) return true;
  if (snapshot.content === undefined || expected.contentHash === undefined) return false;
  if (createHash('sha256').update(snapshot.content, 'utf8').digest('hex') !== expected.contentHash) return false;
  const fields: Array<'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino' | 'mode'> = ['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino', 'mode'];
  return fields.every((field) => expected[field] === undefined || snapshot[field] === expected[field]);
}

export async function restoreTurnUndoContentSafely(input: {
  workspaceRoot: string;
  repositoryRoot: string;
  path: string;
  repositoryPath: string;
  expected: TurnUndoExpectedState;
  beforeContent: string;
  beforeMode?: number;
}): Promise<void> {
  if (!isSafeTurnFilePath(input.path) || !isSafeTurnFilePath(input.repositoryPath)
    || isSensitiveTurnFilePath(input.path)) throw new Error('The restore path is not eligible.');
  const workspaceRoot = await realpath(input.workspaceRoot);
  const repositoryRoot = await realpath(input.repositoryRoot);
  if (normalizeAbsolute(workspaceRoot) !== normalizeAbsolute(input.workspaceRoot)
    || normalizeAbsolute(repositoryRoot) !== normalizeAbsolute(input.repositoryRoot)) {
    throw new Error('A captured root now resolves to a different path.');
  }
  const filePath = path.resolve(workspaceRoot, ...input.path.split('/'));
  if (!isInside(workspaceRoot, filePath) || !isInside(repositoryRoot, filePath)) throw new Error('The restore path leaves the workspace.');
  const repositoryPath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
  if (normalizeRelative(repositoryPath) !== normalizeRelative(input.repositoryPath)) throw new Error('The repository path changed.');

  const parts = input.path.split('/');
  let parent = workspaceRoot;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const parentStats = await lstat(parent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error('A parent directory is no longer safe.');
    const resolvedParent = await realpath(parent);
    if (normalizeAbsolute(resolvedParent) !== normalizeAbsolute(parent) || !isInside(workspaceRoot, resolvedParent)) {
      throw new Error('A parent directory resolves outside the workspace.');
    }
  }
  const leafPath = path.join(parent, parts.at(-1)!);
  const replacement = Buffer.from(input.beforeContent, 'utf8');
  if (!input.expected.exists) {
    try {
      await lstat(leafPath);
      throw new Error('A file appeared at the restore path.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (input.beforeMode !== undefined && (input.beforeMode & 0o7000) !== 0) throw new Error('The original file mode is not eligible.');
    const mode = (input.beforeMode ?? 0o100666) & 0o777;
    const handle = await openFile(leafPath, 'wx', mode);
    try {
      const openedStats = await handle.stat();
      const pathStats = await lstat(leafPath);
      const resolvedPath = await realpath(leafPath);
      if (!openedStats.isFile() || openedStats.nlink > 1 || !pathStats.isFile() || pathStats.isSymbolicLink()
        || pathStats.nlink > 1 || pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino
        || normalizeAbsolute(resolvedPath) !== normalizeAbsolute(leafPath)
        || !isInside(workspaceRoot, resolvedPath) || !isInside(repositoryRoot, resolvedPath)) {
        throw new Error('The new file path changed during restore.');
      }
      await handle.writeFile(replacement);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await openFile(leafPath, fsConstants.O_RDWR | noFollow);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.isSymbolicLink() || openedStats.nlink > 1) throw new Error('The file identity changed.');
    const currentBytes = await handle.readFile();
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(currentBytes);
    } catch {
      throw new Error('The file is no longer valid UTF-8 text.');
    }
    const currentSnapshot: TurnUndoSnapshot = {
      exists: true,
      content,
      size: openedStats.size,
      mtimeMs: openedStats.mtimeMs,
      ctimeMs: openedStats.ctimeMs,
      dev: openedStats.dev,
      ino: openedStats.ino,
      mode: openedStats.mode,
    };
    if (!turnUndoSnapshotMatches(currentSnapshot, input.expected)) throw new Error('The file changed after the run.');

    const pathStats = await lstat(leafPath);
    const resolvedPath = await realpath(leafPath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink > 1
      || pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino
      || normalizeAbsolute(resolvedPath) !== normalizeAbsolute(leafPath)
      || !isInside(workspaceRoot, resolvedPath) || !isInside(repositoryRoot, resolvedPath)) {
      throw new Error('The file path changed after the run.');
    }
    await handle.truncate(0);
    let offset = 0;
    while (offset < replacement.length) {
      const result = await handle.write(replacement, offset, replacement.length - offset, offset);
      if (result.bytesWritten <= 0) throw new Error('The file could not be fully restored.');
      offset += result.bytesWritten;
    }
    await handle.truncate(replacement.length);
    if (input.beforeMode !== undefined) {
      if ((input.beforeMode & 0o7000) !== 0) throw new Error('The original file mode is not eligible.');
      await handle.chmod(input.beforeMode & 0o777);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function expectedState(snapshot: TurnUndoSnapshot): TurnUndoExpectedState {
  return {
    exists: snapshot.exists,
    ...(snapshot.content === undefined ? {} : { contentHash: createHash('sha256').update(snapshot.content, 'utf8').digest('hex') }),
    ...(snapshot.size === undefined ? {} : { size: snapshot.size }),
    ...(snapshot.mtimeMs === undefined ? {} : { mtimeMs: snapshot.mtimeMs }),
    ...(snapshot.ctimeMs === undefined ? {} : { ctimeMs: snapshot.ctimeMs }),
    ...(snapshot.dev === undefined ? {} : { dev: snapshot.dev }),
    ...(snapshot.ino === undefined ? {} : { ino: snapshot.ino }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
  };
}

function hasUnsafeGitState(file: TurnUndoGitFile | undefined): boolean {
  return Boolean(file?.status.some((status) => status === 'Staged' || status === 'Conflict'));
}

function normalizeAbsolute(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
