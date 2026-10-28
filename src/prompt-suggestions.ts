const MAX_RESPONSE_CHARS = 8_000;
const MAX_SUGGESTION_CHARS = 240;
const MAX_SUGGESTIONS = 3;

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
  if (/^(?:here are (?:three|some|a few) )?(?:follow[- ]?up )?suggestions:?$/i.test(cleaned)) return undefined;
  return cleaned;
}

/** Extract up to three bounded, plain-text prompts from common model response formats. */
export function parsePromptSuggestions(value: string): string[] {
  const source = value.slice(0, MAX_RESPONSE_CHARS).replace(/^\[DONE:\d+\]\s*/i, '').trim();
  if (!source) return [];

  const structured = parseStructuredResponse(source);
  const candidates = structured.length ? structured : source
    .replace(/```(?:json|text)?/gi, '')
    .split(/\r?\n/);
  const suggestions: string[] = [];
  for (const candidate of candidates) {
    const cleaned = cleanSuggestion(candidate);
    if (!cleaned || suggestions.some((item) => item.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) continue;
    suggestions.push(cleaned);
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions;
}
