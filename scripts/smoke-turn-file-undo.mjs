import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createTurnUndoAction,
  restoreTurnUndoContentSafely,
  turnUndoSnapshotMatches,
} from '../dist/turn-file-undo.cjs';

const head = 'a'.repeat(40);
const makeSnapshot = (content, overrides = {}) => ({
  exists: true,
  content,
  size: Buffer.byteLength(content),
  mode: 0o100644,
  mtimeMs: 10,
  ctimeMs: 11,
  dev: 1,
  ino: 2,
  ...overrides,
});
const after = (overrides = {}) => ({
  path: 'src/app.ts',
  repositoryPath: 'src/app.ts',
  status: ['Modified'],
  untracked: false,
  snapshot: makeSnapshot('after'),
  ...overrides,
});

const cleanTrackedChange = createTurnUndoAction({
  after: after(),
  afterSnapshot: makeSnapshot('after'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
});
assert.equal(cleanTrackedChange?.kind, 'restore-head', 'clean tracked files restore to the unchanged baseline commit');
assert.equal(cleanTrackedChange?.headCommit, head);

const deletedTrackedChange = createTurnUndoAction({
  after: after(),
  afterSnapshot: { exists: false },
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
});
assert.equal(deletedTrackedChange?.kind, 'restore-head', 'deleted clean tracked files restore from the baseline commit');
assert.equal(deletedTrackedChange?.expected.exists, false);

const dirtyFile = createTurnUndoAction({
  before: {
    path: 'src/app.ts',
    repositoryPath: 'src/app.ts',
    status: ['Modified'],
    untracked: false,
    snapshot: makeSnapshot('before'),
  },
  after: after(),
  afterSnapshot: makeSnapshot('after'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
});
assert.equal(dirtyFile?.kind, 'restore-content', 'pre-existing unstaged edits restore from the captured baseline');
assert.equal(dirtyFile?.beforeContent, 'before');

const newUntrackedFile = createTurnUndoAction({
  after: after({ path: 'src/new.ts', repositoryPath: 'src/new.ts', status: ['Untracked'], untracked: true }),
  afterSnapshot: makeSnapshot('new file'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
});
assert.equal(newUntrackedFile?.kind, 'trash-created', 'new untracked files are moved to Trash');

const recreatedDeletedFile = createTurnUndoAction({
  before: {
    path: 'src/app.ts',
    repositoryPath: 'src/app.ts',
    status: ['Modified'],
    untracked: false,
    snapshot: { exists: false },
  },
  after: after(),
  afterSnapshot: makeSnapshot('recreated'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
});
assert.equal(recreatedDeletedFile?.kind, 'trash-created', 'Undo preserves a pre-run deletion');

assert.equal(createTurnUndoAction({
  after: after({ status: ['Staged', 'Modified'] }),
  afterSnapshot: makeSnapshot('after'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
}), undefined, 'staged changes are not undoable');
assert.equal(createTurnUndoAction({
  after: after({ path: '.env.local', repositoryPath: '.env.local' }),
  afterSnapshot: makeSnapshot('after'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
}), undefined, 'sensitive paths are not undoable');
assert.equal(createTurnUndoAction({
  after: after(),
  afterSnapshot: makeSnapshot('after'),
  baselineHead: head,
  currentHead: 'b'.repeat(40),
  baselineTruncated: false,
  currentTruncated: false,
}), undefined, 'a changed Git HEAD invalidates restore-to-HEAD plans');
assert.equal(createTurnUndoAction({
  after: after(),
  afterSnapshot: { exists: true, omittedReason: 'binary' },
  baselineHead: head,
  currentHead: head,
  baselineTruncated: false,
  currentTruncated: false,
}), undefined, 'incomplete snapshots are not undoable');
assert.equal(createTurnUndoAction({
  after: after(),
  afterSnapshot: makeSnapshot('after'),
  baselineHead: head,
  currentHead: head,
  baselineTruncated: true,
  currentTruncated: false,
}), undefined, 'truncated Git listings are not undoable');

assert.equal(turnUndoSnapshotMatches(makeSnapshot('after'), cleanTrackedChange.expected), true);
assert.equal(turnUndoSnapshotMatches(makeSnapshot('user edit'), cleanTrackedChange.expected), false, 'content edits invalidate an undo');
assert.equal(turnUndoSnapshotMatches(makeSnapshot('after', { ino: 99 }), cleanTrackedChange.expected), false, 'replaced file identities invalidate an undo');
assert.equal(turnUndoSnapshotMatches(makeSnapshot('after', { mode: 0o100600 }), cleanTrackedChange.expected), false, 'permission changes invalidate an undo');
assert.equal(turnUndoSnapshotMatches({ exists: false }, { exists: true }), false);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-turn-file-undo-'));
try {
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const repositoryRoot = workspaceRoot;
  const sourceDirectory = path.join(workspaceRoot, 'src');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = path.join(sourceDirectory, 'app.ts');
  await writeFile(sourcePath, 'after on disk\n', 'utf8');
  const sourceStats = await stat(sourcePath);
  const physicalSnapshot = {
    exists: true,
    content: 'after on disk\n',
    size: sourceStats.size,
    mtimeMs: sourceStats.mtimeMs,
    ctimeMs: sourceStats.ctimeMs,
    dev: sourceStats.dev,
    ino: sourceStats.ino,
    mode: sourceStats.mode,
  };
  const physicalAction = createTurnUndoAction({
    before: {
      path: 'src/app.ts',
      repositoryPath: 'src/app.ts',
      status: ['Modified'],
      untracked: false,
      snapshot: { exists: true, content: 'before on disk\n', mode: sourceStats.mode },
    },
    after: { path: 'src/app.ts', repositoryPath: 'src/app.ts', status: ['Modified'], untracked: false },
    afterSnapshot: physicalSnapshot,
    baselineHead: head,
    currentHead: head,
    baselineTruncated: false,
    currentTruncated: false,
  });
  assert.equal(physicalAction?.kind, 'restore-content');
  await restoreTurnUndoContentSafely({
    workspaceRoot,
    repositoryRoot,
    path: physicalAction.path,
    repositoryPath: physicalAction.repositoryPath,
    expected: physicalAction.expected,
    beforeContent: physicalAction.beforeContent,
    beforeMode: physicalAction.beforeMode,
  });
  assert.equal(await readFile(sourcePath, 'utf8'), 'before on disk\n', 'safe restore writes the pre-run text');

  await writeFile(sourcePath, 'after on disk again\n', 'utf8');
  const changedStats = await stat(sourcePath);
  const changedSnapshot = {
    exists: true,
    content: 'after on disk again\n',
    size: changedStats.size,
    mtimeMs: changedStats.mtimeMs,
    ctimeMs: changedStats.ctimeMs,
    dev: changedStats.dev,
    ino: changedStats.ino,
  };
  const changedAction = createTurnUndoAction({
    before: { path: 'src/app.ts', repositoryPath: 'src/app.ts', status: ['Modified'], untracked: false, snapshot: { exists: true, content: 'original\n', mode: changedStats.mode } },
    after: { path: 'src/app.ts', repositoryPath: 'src/app.ts', status: ['Modified'], untracked: false },
    afterSnapshot: changedSnapshot,
    baselineHead: head,
    currentHead: head,
    baselineTruncated: false,
    currentTruncated: false,
  });
  await writeFile(sourcePath, 'user edit after the run\n', 'utf8');
  await assert.rejects(restoreTurnUndoContentSafely({
    workspaceRoot,
    repositoryRoot,
    path: changedAction.path,
    repositoryPath: changedAction.repositoryPath,
    expected: changedAction.expected,
    beforeContent: changedAction.beforeContent,
    beforeMode: changedAction.beforeMode,
  }), /changed after the run/);
  assert.equal(await readFile(sourcePath, 'utf8'), 'user edit after the run\n', 'a later user edit is preserved');

  const deletedBeforePath = path.join(sourceDirectory, 'deleted.ts');
  const restoreDeleted = createTurnUndoAction({
    before: {
      path: 'src/deleted.ts',
      repositoryPath: 'src/deleted.ts',
      status: ['Modified'],
      untracked: false,
      snapshot: { exists: true, content: 'deleted before\n', mode: 0o100755 },
    },
    after: { path: 'src/deleted.ts', repositoryPath: 'src/deleted.ts', status: ['Modified'], untracked: false },
    afterSnapshot: { exists: false },
    baselineHead: head,
    currentHead: head,
    baselineTruncated: false,
    currentTruncated: false,
  });
  assert.equal(restoreDeleted?.kind, 'restore-content');
  await restoreTurnUndoContentSafely({
    workspaceRoot,
    repositoryRoot,
    path: restoreDeleted.path,
    repositoryPath: restoreDeleted.repositoryPath,
    expected: restoreDeleted.expected,
    beforeContent: restoreDeleted.beforeContent,
    beforeMode: restoreDeleted.beforeMode,
  });
  assert.equal(await readFile(deletedBeforePath, 'utf8'), 'deleted before\n', 'safe restore recreates a deleted baseline file');

  const outsideRoot = path.join(temporaryRoot, 'outside');
  await mkdir(outsideRoot);
  const outsidePath = path.join(outsideRoot, 'escape.txt');
  await writeFile(outsidePath, 'outside remains unchanged\n', 'utf8');
  const linkedDirectory = path.join(workspaceRoot, 'linked');
  let symlinkAvailable = true;
  try {
    await symlink(outsideRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) symlinkAvailable = false;
    else throw error;
  }
  if (symlinkAvailable) {
    const outsideStats = await stat(outsidePath);
    await assert.rejects(restoreTurnUndoContentSafely({
      workspaceRoot,
      repositoryRoot,
      path: 'linked/escape.txt',
      repositoryPath: 'linked/escape.txt',
      expected: {
        exists: true,
        contentHash: cleanTrackedChange.expected.contentHash,
        size: outsideStats.size,
        mtimeMs: outsideStats.mtimeMs,
        ctimeMs: outsideStats.ctimeMs,
        dev: outsideStats.dev,
        ino: outsideStats.ino,
      },
      beforeContent: 'overwritten outside\n',
    }), /parent directory/);
    assert.equal(await readFile(outsidePath, 'utf8'), 'outside remains unchanged\n', 'symlink paths never write outside the workspace');
  }
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const temporaryRelative = path.relative(path.resolve(os.tmpdir()), resolvedTemporaryRoot);
  assert.ok(temporaryRelative && !path.isAbsolute(temporaryRelative)
    && temporaryRelative !== '..' && !temporaryRelative.startsWith(`..${path.sep}`),
  'cleanup target stays under the OS temp directory');
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}

console.log('Turn-file undo policy and filesystem smoke checks passed.');
