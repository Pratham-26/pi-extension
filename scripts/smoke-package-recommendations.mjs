import assert from 'node:assert/strict';
import { loadRecommendedPiPackages } from '../dist/package-recommendations.cjs';

const fixtures = new Map([
  ['pi-subagents', { name: 'pi-subagents', version: '1.2.3', keywords: ['pi-package'], description: 'Agent tools' }],
  ['@inobit/pi-todo', { name: '@inobit/pi-todo', version: '2.0.0', keywords: ['pi-package'] }],
  ['@plannotator/pi-extension', { name: '@plannotator/pi-extension', version: '0.4.5', keywords: ['PI-PACKAGE'] }],
]);

function responseFor(url, payload, options = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'application/json' },
  });
  Object.defineProperty(response, 'url', { value: options.responseUrl ?? url.href });
  return response;
}

const requests = [];
const validResults = await loadRecommendedPiPackages(async (input, init) => {
  const url = new URL(input);
  requests.push({ url, init });
  const name = decodeURIComponent(url.pathname.replace(/\/latest$/, '').slice(1));
  return responseFor(url, fixtures.get(name));
}, new AbortController().signal);

assert.equal(validResults.length, 3);
assert.deepEqual(validResults.map(({ source }) => source), [
  'npm:pi-subagents@1.2.3',
  'npm:@inobit/pi-todo@2.0.0',
  'npm:@plannotator/pi-extension@0.4.5',
]);
assert.ok(validResults.every((item) => typeof item.recommendation === 'string' && item.recommendation.length > 0));
assert.equal(requests.length, 3);
for (const { url, init } of requests) {
  assert.equal(url.origin, 'https://registry.npmjs.org');
  assert.equal(url.pathname.endsWith('/latest'), true);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
}

const invalidResults = await loadRecommendedPiPackages(async (input) => {
  const url = new URL(input);
  const name = decodeURIComponent(url.pathname.replace(/\/latest$/, '').slice(1));
  const fixture = fixtures.get(name);
  if (name === 'pi-subagents') return responseFor(url, { ...fixture, name: 'other-package' });
  if (name === '@inobit/pi-todo') return responseFor(url, { ...fixture, version: 'latest' });
  return responseFor(url, fixture, { responseUrl: `https://registry-mirror.example${url.pathname}` });
}, new AbortController().signal);
assert.deepEqual(invalidResults, []);

const mixedResults = await loadRecommendedPiPackages(async (input) => {
  const url = new URL(input);
  const name = decodeURIComponent(url.pathname.replace(/\/latest$/, '').slice(1));
  if (name === 'pi-subagents') {
    return responseFor(url, fixtures.get(name), { headers: { 'content-length': String(128 * 1024 + 1) } });
  }
  if (name === '@inobit/pi-todo') return responseFor(url, { ...fixtures.get(name), keywords: [] });
  return responseFor(url, fixtures.get(name));
}, new AbortController().signal);
assert.deepEqual(mixedResults.map(({ name }) => name), ['@plannotator/pi-extension']);

console.log('Package recommendation smoke checks passed.');
