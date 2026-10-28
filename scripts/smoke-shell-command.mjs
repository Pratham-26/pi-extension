import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePiShellCommandInput, validatePiShellCommand } = require('../dist/shell-command.cjs');

assert.deepEqual(parsePiShellCommandInput('!  pwd'), { command: 'pwd', excludeFromContext: false });
assert.deepEqual(parsePiShellCommandInput('!! echo private'), { command: 'echo private', excludeFromContext: true });
assert.equal(parsePiShellCommandInput('explain this command'), undefined);
assert.equal(validatePiShellCommand('git status'), undefined);
assert.equal(validatePiShellCommand(''), 'Enter a command after !.');
assert.match(validatePiShellCommand('x'.repeat(16_001)), /16,000 characters/);
assert.match(validatePiShellCommand('echo\u0000unsafe'), /control characters/);
assert.equal(validatePiShellCommand('printf "one\ttwo\n"'), undefined);

console.log('Shell-command smoke check passed: ! and !! parsing, context exclusion, length limits, and control-character validation behaved as expected.');
