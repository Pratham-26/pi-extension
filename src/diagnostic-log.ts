import { appendFile, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type DiagnosticCategory = 'Pi runtime error' | 'Pi operation error' | 'Pi worker error' | 'Pi worker exited unexpectedly';

export const DIAGNOSTIC_LOG_FILENAME = 'diagnostics.log';
export const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;
const DIAGNOSTIC_CATEGORIES = new Set<DiagnosticCategory>([
  'Pi runtime error',
  'Pi operation error',
  'Pi worker error',
  'Pi worker exited unexpectedly',
]);

export async function appendDiagnosticLog(
  storageDirectory: string,
  at: string,
  category: DiagnosticCategory,
  maxBytes = MAX_DIAGNOSTIC_LOG_BYTES,
): Promise<void> {
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ? at : new Date().toISOString();
  if (!DIAGNOSTIC_CATEGORIES.has(category)) throw new Error('Unsupported diagnostic category.');
  const line = `${timestamp} ${category}\n`;
  const logPath = join(storageDirectory, DIAGNOSTIC_LOG_FILENAME);
  await mkdir(storageDirectory, { recursive: true });
  try {
    const logStats = await lstat(logPath);
    if (!logStats.isFile() || logStats.isSymbolicLink()) throw new Error('Diagnostic log path is not a regular file.');
    if (logStats.size + Buffer.byteLength(line, 'utf8') > maxBytes) {
      const previousPath = join(storageDirectory, 'diagnostics.previous.log');
      try {
        await unlink(previousPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(logPath, previousPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
}
