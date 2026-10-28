const assert = require('node:assert/strict');
const {
  boundTurnFileDiff,
  createTurnFileDiff,
  isSafeTurnFilePath,
  isSensitiveTurnFilePath,
} = require('../dist/turn-file-summary.cjs');

const patch = createTurnFileDiff('src/example.ts', 'const oldValue = 1;\n', 'const newValue = 2;\n');
assert.match(patch, /^--- a\/src\/example\.ts\tbefore Pi run$/m);
assert.match(patch, /^-const oldValue = 1;$/m);
assert.match(patch, /^\+const newValue = 2;$/m);
assert.equal(createTurnFileDiff('src/example.ts', 'same\n', 'same\n'), '');
assert.throws(() => createTurnFileDiff('../outside.txt', '', 'unsafe'), /Unsafe/);

assert.equal(isSafeTurnFilePath('src/example.ts'), true);
assert.equal(isSafeTurnFilePath('.git/config'), false);
assert.equal(isSafeTurnFilePath('folder/../outside.txt'), false);
assert.equal(isSensitiveTurnFilePath('.env.production'), true);
assert.equal(isSensitiveTurnFilePath('.ssh/id_ed25519'), true);
assert.equal(isSensitiveTurnFilePath('services/credentials.json'), true);
assert.equal(isSensitiveTurnFilePath('src/tokenizer.ts'), false);

const redacted = createTurnFileDiff('src/config.ts', '', 'const API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz123456";\n');
assert.equal(redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'), false);
assert.match(redacted, /\[redacted\]/);

const privateKey = createTurnFileDiff('src/signing.ts', '', [
  'const signingKey = `-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  '-----END PRIVATE KEY-----`;',
  '',
].join('\n'));
assert.equal(privateKey.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), false);
assert.match(privateKey, /redacted private-key data/);

const bounded = boundTurnFileDiff('x'.repeat(100), 24);
assert.equal(bounded.truncated, true);
assert.equal(bounded.diff.length, 24);
assert.match(bounded.diff, /truncated/);

console.log('Turn file summary smoke checks passed.');
