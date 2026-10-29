const MAX_RESPONSE_CHARS = 8_000;
const MAX_SUGGESTION_CHARS = 240;
const MAX_SUGGESTIONS = 3;
const GENERIC_FOLLOW_UPS = [
  'Review the answer for missing edge cases, risks, or assumptions.',
  'Summarize the key changes and the next steps to validate them.',
  'Explain the main trade-offs and any reasonable alternatives.',
];

function structuredSuggestions(value: unknown, depth = 0): unknown[] {
  if (depth > 5) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => structuredSuggestions(item, depth + 1));
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  for (const key of ['suggestions', 'followUps', 'followUpPrompts', 'prompts', 'questions', 'items']) {
    if (Array.isArray(record[key])) return structuredSuggestions(record[key], depth + 1);
  }
  for (const key of ['prompt', 'suggestion', 'text', 'question']) {
    if (typeof record[key] === 'string') return [record[key]];
  }
  return [];
}

function parseStructuredResponse(source: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(source);
    const candidates = structuredSuggestions(parsed);
    if (candidates.length) return candidates;
  } catch {
    // Models sometimes wrap valid JSON in prose or a Markdown code fence.
  }

  // Find balanced JSON arrays instead of slicing from the first '[' to the last ']'.
  // Pi responses may contain markers such as [DONE:3] before the actual list.
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (start < 0) {
      if (character === '[') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(source.slice(start, index + 1));
          const candidates = structuredSuggestions(parsed);
          if (candidates.length) return candidates;
        } catch {
          // Continue to later arrays; an earlier marker may look like a bracketed list.
        }
        start = -1;
      }
    }
  }
  return [];
}

function splitPlainSuggestions(source: string): string[] {
  const plain = source.replace(/```(?:json|text)?/gi, '').trim();
  const lines = plain.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines;

  // Some providers flatten a numbered list into one line. Split only a clear
  // sequential list so ordinary prose, decimals, and file names stay intact.
  const markers = [...plain.matchAll(/(^|\s)(\d{1,2}[.)]|\(\d{1,2}\))\s+/g)];
  if (markers.length >= 2) {
    const numbers = markers.map((match) => Number(match[2].match(/\d+/)?.[0]));
    const isSequential = numbers.every((number, index) => number === index + 1);
    if (isSequential) {
      return markers.map((match, index) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = index + 1 < markers.length ? markers[index + 1].index ?? plain.length : plain.length;
        return plain.slice(start, end).trim();
      });
    }
  }

  const bullets = [...plain.matchAll(/(^|\s)([-*•])\s+/g)];
  if (bullets.length >= 2) {
    return bullets.map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < bullets.length ? bullets[index + 1].index ?? plain.length : plain.length;
      return plain.slice(start, end).trim();
    });
  }

  return lines;
}

function cleanSuggestion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+|\(\d+\)\s+|\d+:\s+)/, '')
    .replace(/^\s*(?:suggestion|follow[- ]?up)\s*\d*\s*:\s*/i, '')
    .replace(/^['"“”`]+|['"“”`]+$/g, '')
    .replace(/^\*\*(.*?)\*\*$/, '$1')
    .replace(/^\*(.*?)\*$/, '$1')
    .trim();
  if (cleaned.length < 8 || cleaned.length > MAX_SUGGESTION_CHARS) return undefined;
  if (/^(?:here (?:are|is) )?(?:(?:three|some|a few) )?(?:possible )?(?:follow[- ]?up )?(?:suggestions?|prompts?|questions?)(?:\s+for .{1,80})?:?$/i.test(cleaned)) return undefined;
  return cleaned;
}

/** Extract up to three bounded, plain-text prompts from common model response formats. */
export function parsePromptSuggestions(value: string): string[] {
  const source = value.slice(0, MAX_RESPONSE_CHARS).replace(/^\[DONE:\d+\]\s*/i, '').trim();
  if (!source) return [];

  const structured = parseStructuredResponse(source);
  const candidates = structured.length ? structured : splitPlainSuggestions(source);
  const suggestions: string[] = [];
  for (const candidate of candidates) {
    const cleaned = cleanSuggestion(candidate);
    if (!cleaned || suggestions.some((item) => item.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) continue;
    suggestions.push(cleaned);
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions;
}

/** Fill missing model suggestions with safe, directly usable general prompts. */
export function fillPromptSuggestionFallback(suggestions: string[]): { suggestions: string[]; usedFallback: boolean } {
  const output: string[] = [];
  for (const value of suggestions) {
    const cleaned = cleanSuggestion(value);
    if (!cleaned || output.some((item) => item.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) continue;
    output.push(cleaned);
    if (output.length === MAX_SUGGESTIONS) return { suggestions: output, usedFallback: false };
  }
  const originalCount = output.length;
  for (const value of GENERIC_FOLLOW_UPS) {
    if (output.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) continue;
    output.push(value);
    if (output.length === MAX_SUGGESTIONS) break;
  }
  return { suggestions: output, usedFallback: output.length > originalCount };
}
