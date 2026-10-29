import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = await build({
  entryPoints: [join(root, 'src', 'prompt-suggestions.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`;
const { fillPromptSuggestionFallback, parsePromptSuggestions } = await import(moduleUrl);

assert.deepEqual(
  parsePromptSuggestions('[DONE:3]\n1. Review the error handling paths.\n2. Add a test for the empty response.\n3. Explain the main trade-offs.'),
  ['Review the error handling paths.', 'Add a test for the empty response.', 'Explain the main trade-offs.'],
  'numbered lines after a Pi completion marker should parse as three prompts',
);
assert.deepEqual(
  parsePromptSuggestions('```json\n{"suggestions":["Check edge cases in the parser.","Summarize the validation steps."]}\n```'),
  ['Check edge cases in the parser.', 'Summarize the validation steps.'],
  'fenced structured output should yield the model prompts',
);
assert.deepEqual(
  parsePromptSuggestions('Here are three follow-up prompts: 1. Check edge cases in the parser. 2. Add focused coverage for empty input. 3. Summarize the validation steps.'),
  ['Check edge cases in the parser.', 'Add focused coverage for empty input.', 'Summarize the validation steps.'],
  'a flattened numbered response should discard its heading and split into usable prompts',
);
assert.deepEqual(
  parsePromptSuggestions('• Check edge cases in the parser. • Add focused coverage for empty input. • Summarize the validation steps.'),
  ['Check edge cases in the parser.', 'Add focused coverage for empty input.', 'Summarize the validation steps.'],
  'inline bullet responses should split into usable prompts',
);

const completed = fillPromptSuggestionFallback(['Review the error handling paths.']);
assert.equal(completed.suggestions.length, 3, 'unusable or partial model output should still offer three prompts');
assert.equal(completed.suggestions[0], 'Review the error handling paths.', 'a valid model prompt should be retained');
assert.equal(completed.usedFallback, true, 'the UI should identify general fallback prompts');
assert.ok(completed.suggestions.every((suggestion) => suggestion.length >= 8 && suggestion.length <= 240));

const complete = fillPromptSuggestionFallback([
  'Review the error handling paths.',
  'Add a test for the empty response.',
  'Explain the main trade-offs.',
]);
assert.equal(complete.usedFallback, false, 'complete model output should not be labeled as fallback');
assert.equal(complete.suggestions.length, 3);

console.log('Prompt suggestion smoke check passed: line and JSON output parse; partial/unusable output receives bounded general prompts.');
