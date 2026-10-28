import * as path from 'node:path';

/** Restrict package input to documented source forms and reject option-like npm specs. */
export function isPiPackageSource(source: string): boolean {
  if (!source || source.length > 512 || /[\u0000-\u001f\u007f]/.test(source) || source !== source.trim()) return false;

  if (source.startsWith('npm:')) {
    const spec = source.slice('npm:'.length);
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9*^~<>=][a-z0-9.+*^~<>=|_-]*)?$/i.test(spec);
  }

  if (source.startsWith('git:')) {
    const spec = source.slice('git:'.length);
    const refIndex = spec.lastIndexOf('@');
    const repo = refIndex > 0 ? spec.slice(0, refIndex) : spec;
    const ref = refIndex > 0 ? spec.slice(refIndex + 1) : '';
    const repoParts = repo.split('/');
    return /^[a-z0-9][a-z0-9.-]*$/i.test(repoParts[0] ?? '')
      && repoParts.length >= 3
      && repoParts.slice(1).every((part) => /^[a-z0-9._-]+$/i.test(part) && part !== '.' && part !== '..')
      && (!ref || /^[a-z0-9][a-z0-9._/-]*$/i.test(ref));
  }

  if (source.startsWith('https://')) {
    try {
      const url = new URL(source);
      return url.protocol === 'https:'
        && Boolean(url.hostname)
        && !url.username
        && !url.password
        && !url.search
        && !url.hash
        && url.pathname.split('/').filter(Boolean).length >= 2;
    } catch {
      return false;
    }
  }

  if (source.startsWith('./') || source.startsWith('../') || source.startsWith('.\\') || source.startsWith('..\\')) return true;
  return path.isAbsolute(source);
}
