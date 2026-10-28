import { minimatch } from 'minimatch';

export interface ModelScopeModel {
  provider: string;
  id: string;
}

export interface ResolvedModelScopeItem<T extends ModelScopeModel> {
  model: T;
  thinkingLevel?: string;
}

/** Resolve Pi's saved model-scope patterns without refreshing provider catalogs. */
export function resolveModelScopePatterns<T extends ModelScopeModel>(
  patterns: readonly string[],
  models: readonly T[],
): { scopedModels: Array<ResolvedModelScopeItem<T>>; unmatched: string[] } {
  const scopedModels: Array<ResolvedModelScopeItem<T>> = [];
  const included = new Set<string>();
  const unmatched: string[] = [];
  const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const rawPattern of patterns.slice(0, 2_000)) {
    if (typeof rawPattern !== 'string' || rawPattern.length > 512 || /[\u0000-\u001f\u007f]/.test(rawPattern)) continue;
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    let matchPattern = pattern;
    let thinkingLevel: string | undefined;
    let matches = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === pattern.toLowerCase());
    if (!matches.length) matches = models.filter((model) => model.id.toLowerCase() === pattern.toLowerCase());
    if (!matches.length) {
      const suffix = pattern.match(/:(off|minimal|low|medium|high|xhigh|max)$/i);
      if (suffix && thinkingLevels.has(suffix[1].toLowerCase())) {
        matchPattern = pattern.slice(0, -suffix[0].length);
        thinkingLevel = suffix[1].toLowerCase();
      }
      matches = models.filter((model) => {
        const reference = `${model.provider}/${model.id}`;
        return minimatch(reference, matchPattern, { nocase: true }) || minimatch(model.id, matchPattern, { nocase: true });
      });
    }
    if (!matches.length) {
      if (!unmatched.includes(pattern)) unmatched.push(pattern);
      continue;
    }
    for (const model of matches) {
      const id = `${model.provider}/${model.id}`;
      if (included.has(id)) continue;
      included.add(id);
      scopedModels.push({ model, ...(thinkingLevel ? { thinkingLevel } : {}) });
    }
  }
  return { scopedModels, unmatched };
}
