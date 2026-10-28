import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const drafts = require('../src/draft-store.js');

const textDraft = drafts.makeDraft('Inspect this code', [{
  id: 'file-1', label: 'src/main.ts', path: 'src/main.ts', context: 'const answer = 42;',
}]);
assert.equal(textDraft.text, 'Inspect this code');
assert.equal(textDraft.attachments[0].context, 'const answer = 42;');

let store = drafts.normalizeStore({});
const first = drafts.saveDraft(store, 'session-a', textDraft);
assert.equal(first.ok, true);
store = first.store;
assert.equal(drafts.getDrafts(store, 'session-b').length, 0, 'drafts should be scoped to their session');

const imageData = 'AQID';
const imageDraft = drafts.makeDraft('Review image', [{
  id: 'image-1', label: 'diagram.png', path: 'diagram.png', context: '', image: { data: imageData, mimeType: 'image/png' },
}]);
const second = drafts.saveDraft(store, 'session-a', imageDraft);
assert.equal(second.ok, true);
store = second.store;
assert.equal(drafts.getDrafts(store, 'session-a')[0].attachments[0].image.data, imageData);

const restored = drafts.restoreDraft(store, 'session-a', 0, drafts.makeDraft('Current composer', []));
assert.equal(restored.ok, true);
assert.equal(restored.swapped, true);
assert.equal(restored.draft.text, 'Review image');
assert.equal(drafts.getDrafts(restored.store, 'session-a')[0].text, 'Current composer', 'restore should swap with occupied composer');

const deleted = drafts.deleteDraft(restored.store, 'session-a', 0);
assert.equal(deleted.ok, true);
assert.equal(drafts.getDrafts(deleted.store, 'session-a').length, 1);
const undone = drafts.undoDelete(deleted.store, 'session-a', deleted.draft, deleted.index);
assert.equal(undone.ok, true);
assert.equal(drafts.getDrafts(undone.store, 'session-a')[0].text, 'Current composer', 'undo should restore the deleted item at its position');
const consumed = drafts.restoreDraft(undone.store, 'session-a', 1, undefined);
assert.equal(consumed.ok, true);
assert.equal(consumed.swapped, false);
assert.equal(drafts.getDrafts(consumed.store, 'session-a').some((draft) => draft.id === consumed.draft.id), false, 'restoring into an empty composer should consume the saved item');

const capped = drafts.normalizeStore({ 'session-a': Array.from({ length: 25 }, (_, index) => ({ text: `Draft ${index}`, attachments: [] })) });
assert.equal(drafts.getDrafts(capped, 'session-a').length, drafts.MAX_DRAFTS_PER_SESSION);

const oversizedImage = 'A'.repeat(5_592_408);
const oversizedDraft = drafts.makeDraft('Large image', [{
  id: 'large-image', label: 'large.png', path: 'large.png', context: '', image: { data: oversizedImage, mimeType: 'image/png' },
}]);
assert.equal(drafts.saveDraft(undone.store, 'session-a', oversizedDraft).ok, true);
let budgetStore = drafts.normalizeStore({});
for (let index = 0; index < 3; index += 1) {
  const result = drafts.saveDraft(budgetStore, `image-session-${index}`, oversizedDraft);
  if (index < 2) {
    assert.equal(result.ok, true);
    budgetStore = result.store;
  } else {
    assert.equal(result.reason, 'storage', 'saved draft storage should remain bounded');
  }
}

const corrupted = drafts.normalizeStore(JSON.parse('{"bad-session":[{"text":"<script>alert(1)</script>","attachments":[{"image":{"data":"not-base64","mimeType":"image/svg+xml"}}]}],"__proto__":[{"text":"prototype pollution","attachments":[]}]}'));
assert.equal(drafts.getDrafts(corrupted, 'bad-session').length, 1, 'plain text remains safe to render via textContent');
assert.equal(Object.getPrototypeOf(corrupted), null, 'loaded session keys must not affect the store prototype');
assert.equal(drafts.getDrafts(corrupted, '__proto__')[0].text, 'prototype pollution');
assert.equal(Object.prototype.polluted, undefined);

const browserContext = {};
runInNewContext(readFileSync(new URL('../dist/draft-store.js', import.meta.url), 'utf8'), browserContext);
assert.equal(typeof browserContext.PiChatDraftStore.makeDraft, 'function', 'the compiled webview bundle should expose the validated draft API');

console.log('Draft smoke check passed: session isolation, text and image context, restore/swap, undo, retention, sanitization, bounded storage, and webview bundle exposure.');
