import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePiShellCommandInput, validatePiShellCommand } = require('../dist/shell-command.cjs');
const { MAX_QUEUED_PI_SHELL_COMMANDS_PER_SESSION, SessionShellCommandQueue } = require('../dist/shell-command-queue.cjs');

assert.deepEqual(parsePiShellCommandInput('!  pwd'), { command: 'pwd', excludeFromContext: false });
assert.deepEqual(parsePiShellCommandInput('!! echo private'), { command: 'echo private', excludeFromContext: true });
assert.equal(parsePiShellCommandInput('explain this command'), undefined);
assert.equal(validatePiShellCommand('git status'), undefined);
assert.equal(validatePiShellCommand(''), 'Enter a command after !.');
assert.match(validatePiShellCommand('x'.repeat(16_001)), /16,000 characters/);
assert.match(validatePiShellCommand('echo\u0000unsafe'), /control characters/);
assert.equal(validatePiShellCommand('printf "one\ttwo\n"'), undefined);

const queue = new SessionShellCommandQueue();
const first = { id: 'a'.repeat(32), command: 'git status', excludeFromContext: false };
const second = { id: 'b'.repeat(32), command: 'echo private', excludeFromContext: true };
assert.equal(queue.enqueue('session-a', first), true);
assert.equal(queue.enqueue('session-a', second), true);
assert.equal(queue.enqueue('session-b', { ...first, id: 'c'.repeat(32) }), true);
assert.deepEqual(queue.first('session-a'), first);
assert.deepEqual(queue.list('session-b'), [{ ...first, id: 'c'.repeat(32) }]);
const exposed = queue.list('session-a');
exposed[0].command = 'changed';
assert.deepEqual(queue.first('session-a'), first, 'queue reads must not expose mutable state');
assert.equal(queue.remove('session-a', second.id), true);
assert.deepEqual(queue.list('session-a'), [first]);
assert.equal(queue.clear('session-a'), 1);
assert.equal(queue.first('session-a'), undefined);
for (let index = 0; index < MAX_QUEUED_PI_SHELL_COMMANDS_PER_SESSION; index += 1) {
  assert.equal(queue.enqueue('session-limit', { ...first, id: index.toString(16).padStart(32, '0') }), true);
}
assert.equal(queue.enqueue('session-limit', { ...first, id: 'f'.repeat(32) }), false);
assert.equal(queue.clearAll(), MAX_QUEUED_PI_SHELL_COMMANDS_PER_SESSION + 1);

console.log('Shell-command smoke check passed: ! and !! parsing, validation, session-scoped FIFO queues, removal, clearing, and queue limits behaved as expected.');
