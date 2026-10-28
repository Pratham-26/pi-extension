import { createTwoFilesPatch } from 'diff';

export const MAX_TURN_FILE_BYTES = 256 * 1024;
export const MAX_TURN_FILE_COUNT = 200;
export const MAX_TURN_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_TURN_SUMMARY_FILES = 24;
export const MAX_TURN_DIFF_FILE_CHARS = 12_000;
export const MAX_TURN_DIFF_TOTAL_CHARS = 64_000;

const sensitiveDirectoryNames = new Set([
  '.aws', '.ssh', '.kube', 'credential', 'credentials', 'secret', 'secrets',
]);
const sensitiveFileNames = new Set([
  '.git-credentials', '.netrc', '.npmrc', '.pypirc', 'credentials.json',
  'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa', 'id_xmss',
]);

export function isSafeTurnFilePath(relativePath: string): boolean {
  if (!relativePath || relativePath.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(relativePath)
    || relativePath !== relativePath.trim() || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) return false;
  const parts = relativePath.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

export function isSensitiveTurnFilePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLocaleLowerCase();
  const parts = normalized.split('/');
  const basename = parts.at(-1) ?? '';
  if (parts.some((part) => sensitiveDirectoryNames.has(part))) return true;
  if (basename.startsWith('.env') || sensitiveFileNames.has(basename)) return true;
  if (/\.(?:pem|key|p12|pfx|p7b|p7c|p8|jks|keystore)$/i.test(basename)) return true;
  return /(?:^|[._-])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|private[-_]?key|client[-_]?secret)(?:[._-]|$)/i.test(basename);
}

export function createTurnFileDiff(relativePath: string, before: string, after: string): string {
  if (!isSafeTurnFilePath(relativePath)) throw new Error('Unsafe workspace-relative path.');
  if (before === after) return '';
  const patch = createTwoFilesPatch(
    `a/${relativePath}`,
    `b/${relativePath}`,
    before,
    after,
    'before Pi run',
    'after Pi run',
    { context: 3 },
  );
  return redactTurnFileDiff(patch);
}

export function redactTurnFileDiff(patch: string): string {
  return redactPotentialSecrets(patch);
}

export function boundTurnFileDiff(value: string, maximumCharacters = MAX_TURN_DIFF_FILE_CHARS): { diff: string; truncated: boolean } {
  if (value.length <= maximumCharacters) return { diff: value, truncated: false };
  const marker = '\n[Diff preview truncated.]';
  const safeMaximum = Math.max(0, maximumCharacters);
  const prefixLength = Math.max(0, safeMaximum - marker.length);
  return { diff: `${value.slice(0, prefixLength)}${marker.slice(0, safeMaximum - prefixLength)}`, truncated: true };
}

function redactPotentialSecrets(patch: string): string {
  const assignment = /^([ +\-](?:\s*(?:export\s+)?(?:const|let|var)\s+)?(?:[\w$.-]+\s*\.\s*)?["'`]?[$\w.-]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|private[-_]?key|client[-_]?secret)[$\w.-]*["'`]?\s*[:=]\s*).+$/i;
  const commonToken = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{24,})\b/g;
  let privateKeyBody = false;
  return patch.split(/\r?\n/).map((line) => {
    if (/^[ +\-].*-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      privateKeyBody = true;
      return line.replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----).*/, '$1 [redacted]');
    }
    if (privateKeyBody && /^[ +\-]/.test(line) && !/^[ +\-].*-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      return `${line.slice(0, 1)}[redacted private-key data]`;
    }
    if (privateKeyBody && /^[ +\-].*-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      privateKeyBody = false;
      return line.replace(/-----END [A-Z0-9 ]*PRIVATE KEY-----.*/, '-----END PRIVATE KEY-----');
    }
    const match = line.match(assignment);
    const redacted = match ? `${match[1]}[redacted]` : line;
    return redacted.replace(commonToken, '[redacted token]');
  }).join('\n');
}
