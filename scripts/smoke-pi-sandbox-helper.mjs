import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const helperPath = path.resolve('dist/pi-sandbox-helper.cjs');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-sandbox-helper-smoke-'));

function call(action, values = {}, expectedExitCode = 0) {
  const child = spawnSync(process.execPath, [helperPath], {
    input: JSON.stringify({ action, ...values }),
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, expectedExitCode, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

try {
  const workspace = path.join(tempRoot, 'workspace');
  const nested = path.join(workspace, 'src');
  const source = path.join(nested, 'sample.ts');
  const image = path.join(workspace, 'sample.png');
  await mkdir(nested, { recursive: true });
  await writeFile(source, 'alpha\nbeta needle\ngamma\n');
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  assert.equal(call('exists', { path: source }).result.exists, true);
  assert.equal(call('stat', { path: nested }).result.isDirectory, true);
  assert.equal(call('imageMime', { path: image }).result.mimeType, 'image/png');
  assert.equal(Buffer.from(call('readFile', { path: source }).result.base64, 'base64').toString(), 'alpha\nbeta needle\ngamma\n');
  assert.ok(call('readdir', { path: nested }).result.entries.includes('sample.ts'));
  assert.ok(call('glob', { path: workspace, pattern: '**/*.ts' }).result.paths.includes(source));
  const grep = call('grep', { path: workspace, pattern: 'beta needle', literal: true });
  assert.equal(grep.result.matches[0].lineNumber, 2);
  assert.equal(grep.result.matches[0].lineText, 'beta needle');

  const created = path.join(workspace, 'new', 'file.txt');
  assert.equal(call('mkdir', { path: path.dirname(created) }).result.ok, true);
  assert.equal(call('writeFile', { path: created, content: 'written safely' }).result.ok, true);
  assert.equal(await readFile(created, 'utf8'), 'written safely');
  assert.equal(call('access', { path: path.join(workspace, 'missing.txt') }, 1).ok, false);

  const invalid = call('readFile', { path: 'relative.txt' }, 1);
  assert.equal(invalid.ok, false);
  console.log('Pi sandbox helper smoke checks passed.');
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 2 });
}
