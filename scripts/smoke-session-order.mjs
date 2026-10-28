import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sortSessionItems } = require('../src/session-order.js');
const sessions = [
  { path: 'pin-zebra', title: 'Zebra pin', modified: 1, pinned: true },
  { path: 'pin-alpha', title: 'Alpha pin', modified: 900, pinned: true },
  { path: 'old', title: 'Zeta', modified: 10, pinned: false },
  { path: 'new', title: 'Beta', modified: 200, pinned: false },
];
const manualOrder = ['new', 'pin-zebra', 'old', 'pin-alpha'];

assert.deepEqual(
  sortSessionItems(sessions, manualOrder, 'manual').map((session) => session.path),
  ['pin-zebra', 'pin-alpha', 'new', 'old'],
  'manual ordering should preserve pinned priority and the saved order within each group',
);
assert.deepEqual(
  sortSessionItems(sessions, manualOrder, 'updated').map((session) => session.path),
  ['pin-alpha', 'pin-zebra', 'new', 'old'],
  'recent ordering should sort by modification time while keeping pins first',
);
assert.deepEqual(
  sortSessionItems(sessions, manualOrder, 'name').map((session) => session.path),
  ['pin-alpha', 'pin-zebra', 'new', 'old'],
  'title ordering should be case-insensitive and keep pins first',
);
assert.deepEqual(
  sortSessionItems(sessions, [], 'manual').map((session) => session.path),
  ['pin-alpha', 'pin-zebra', 'new', 'old'],
  'manual mode should fall back to recent order until the user arranges sessions',
);
assert.deepEqual(sessions.map((session) => session.path), ['pin-zebra', 'pin-alpha', 'old', 'new'], 'sorting should not mutate the source list');

console.log('Session ordering smoke check passed: manual, recent, title, pin priority, fallback order, and immutability.');
