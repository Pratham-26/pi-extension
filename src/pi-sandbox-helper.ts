import { access, lstat, mkdir, open, opendir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WALK_FILES = 20_000;
const MAX_WALK_DIRECTORIES = 20_000;
const MAX_WALK_DEPTH = 64;
const MAX_PATH_CHARS = 4096;
const MAX_RESULT_PAYLOAD_BYTES = MAX_RESULT_BYTES - 64 * 1024;

type Request = {
  action?: unknown;
  path?: unknown;
  content?: unknown;
  pattern?: unknown;
  glob?: unknown;
  ignore?: unknown;
  limit?: unknown;
  ignoreCase?: unknown;
  literal?: unknown;
  context?: unknown;
};

function checkedPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)) {
    throw new Error('Invalid absolute path.');
  }
  return value;
}

function boundedNumber(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

function imageMime(buffer: Buffer, filePath: string): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (buffer.subarray(0, 4).toString('ascii') === 'II*\u0000' || buffer.subarray(0, 4).toString('ascii') === 'MM\u0000*') return 'image/tiff';
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.svg' && buffer.subarray(0, 4096).toString('utf8').includes('<svg')) return 'image/svg+xml';
  if (extension === '.ico' && buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  return null;
}

async function walkFiles(root: string, ignore: string[], maxFiles: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let directoriesScheduled = 1;
  let directoriesVisited = 0;
  let truncated = false;
  const fileLimit = Math.min(MAX_WALK_FILES, maxFiles);
  while (queue.length > 0 && files.length < fileLimit && directoriesVisited < MAX_WALK_DIRECTORIES) {
    const current = queue.pop()!;
    directoriesVisited++;
    if (current.depth > MAX_WALK_DEPTH) {
      truncated = true;
      continue;
    }
    let directory;
    try {
      directory = await opendir(current.directory);
    } catch {
      continue;
    }
    try {
      for await (const entry of directory) {
        if (files.length >= fileLimit) {
          truncated = true;
          break;
        }
        const fullPath = path.join(current.directory, entry.name);
        if (fullPath.length > MAX_PATH_CHARS) {
          truncated = true;
          continue;
        }
        const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
        if (ignore.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) continue;
        if (entry.isDirectory()) {
          if (directoriesScheduled >= MAX_WALK_DIRECTORIES) truncated = true;
          else {
            queue.push({ directory: fullPath, depth: current.depth + 1 });
            directoriesScheduled++;
          }
        }
        else if (entry.isFile()) files.push(fullPath);
      }
    } catch {
      // Keep results from readable entries if a directory changes during traversal.
    }
  }
  if (queue.length > 0 || directoriesVisited >= MAX_WALK_DIRECTORIES || files.length >= fileLimit) truncated = true;
  return { files, truncated };
}

async function resolveSearchFiles(root: string, pattern: string, ignore: string[], limit: number): Promise<{ files: string[]; truncated: boolean }> {
  const info = await stat(root);
  if (!info.isDirectory()) return { files: [root], truncated: false };
  const files = await walkFiles(root, ignore, Math.min(MAX_WALK_FILES, Math.max(limit * 100, 10_000)));
  return {
    files: files.files.filter((file) => minimatch(path.relative(root, file).split(path.sep).join('/'), pattern, { dot: true })),
    truncated: files.truncated,
  };
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const handle = await open(filePath, 'r');
    let buffer: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) return undefined;
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (buffer.length > MAX_FILE_BYTES) return undefined;
    if (buffer.includes(0)) return undefined;
    return buffer.toString('utf8');
  } catch {
    return undefined;
  }
}

async function run(request: Request): Promise<unknown> {
  const action = typeof request.action === 'string' ? request.action : '';
  const filePath = checkedPath(request.path);
  switch (action) {
    case 'readFile': {
      const handle = await open(filePath, 'r');
      let buffer: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Sandboxed Pi read supports regular files only.');
        if (info.size > MAX_FILE_BYTES) throw new Error('File exceeds the sandboxed Pi tool size limit.');
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (buffer.length > MAX_FILE_BYTES) throw new Error('File exceeds the sandboxed Pi tool size limit.');
      return { base64: buffer.toString('base64'), mimeType: imageMime(buffer, filePath) };
    }
    case 'imageMime': {
      const handle = await open(filePath, 'r');
      let buffer = Buffer.alloc(0);
      try {
        const info = await handle.stat();
        if (!info.isFile()) return { mimeType: null };
        buffer = Buffer.alloc(Math.min(info.size, 4096));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        buffer = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      return { mimeType: imageMime(buffer.subarray(0, 4096), filePath) };
    }
    case 'access': {
      const mode = request.content === 'write' ? constants.R_OK | constants.W_OK : constants.R_OK;
      await access(filePath, mode);
      return { ok: true };
    }
    case 'writeFile': {
      if (typeof request.content !== 'string' || Buffer.byteLength(request.content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error('File content exceeds the sandboxed Pi tool size limit.');
      }
      await writeFile(filePath, request.content, { encoding: 'utf8' });
      return { ok: true };
    }
    case 'mkdir':
      await mkdir(filePath, { recursive: true });
      return { ok: true };
    case 'exists':
      try {
        await access(filePath, constants.F_OK);
        return { exists: true };
      } catch {
        return { exists: false };
      }
    case 'stat': {
      const info = await stat(filePath);
      return { isDirectory: info.isDirectory() };
    }
    case 'readdir': {
      const directory = await opendir(filePath);
      const entries: string[] = [];
      try {
        while (entries.length < 20_000) {
          const entry = await directory.read();
          if (!entry) break;
          entries.push(entry.name);
        }
      } finally {
        try { await directory.close(); } catch { /* It may already be closed at end of directory. */ }
      }
      return { entries };
    }
    case 'glob': {
      const pattern = typeof request.pattern === 'string' && request.pattern.length <= 512 ? request.pattern : '';
      const ignore = Array.isArray(request.ignore)
        ? request.ignore.filter((item): item is string => typeof item === 'string' && item.length <= 512).slice(0, 64)
        : [];
      const limit = boundedNumber(request.limit, 1000, 10_000);
      const walked = await walkFiles(filePath, ignore, Math.min(MAX_WALK_FILES, Math.max(limit * 100, 10_000)));
      const results: string[] = [];
      let resultBytes = 0;
      let truncated = walked.truncated;
      for (const candidate of walked.files) {
        if (!minimatch(path.relative(filePath, candidate).split(path.sep).join('/'), pattern, { dot: true })) continue;
        const candidateBytes = Buffer.byteLength(candidate, 'utf8') + 8;
        if (results.length >= limit || resultBytes + candidateBytes > MAX_RESULT_PAYLOAD_BYTES) {
          truncated = true;
          break;
        }
        results.push(candidate);
        resultBytes += candidateBytes;
      }
      return { paths: results, truncated };
    }
    case 'grep': {
      if (typeof request.pattern !== 'string' || request.pattern.length === 0 || request.pattern.length > 512) {
        throw new Error('Search pattern is invalid or too long.');
      }
      const limit = boundedNumber(request.limit, 100, 1000);
      const context = typeof request.context === 'number' && Number.isFinite(request.context)
        ? Math.max(0, Math.min(Math.floor(request.context), 20))
        : 0;
      const ignore = ['**/node_modules/**', '**/.git/**'];
      const candidates = await resolveSearchFiles(filePath,
        typeof request.glob === 'string' && request.glob.length <= 512 ? request.glob : '**', ignore, limit);
      const candidateFiles = candidates.files;
      const matcher = request.literal === true
        ? undefined
        : new RegExp(request.pattern, request.ignoreCase === true ? 'i' : '');
      const needle = request.ignoreCase === true ? request.pattern.toLowerCase() : request.pattern;
      const matches: Array<{ path: string; lineNumber: number; lineText: string; lines: string[]; firstLine: number }> = [];
      let resultBytes = 0;
      let walked = 0;
      let truncated = candidates.truncated;
      search: for (const candidate of candidateFiles) {
        if (matches.length >= limit) break;
        walked++;
        const content = await readTextFile(candidate);
        if (content === undefined) continue;
        const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (let index = 0; index < lines.length && matches.length < limit; index++) {
          const line = lines[index];
          const matched = matcher ? matcher.test(line) : (request.ignoreCase === true ? line.toLowerCase() : line).includes(needle);
          if (matcher) matcher.lastIndex = 0;
          if (!matched) continue;
          const firstLine = Math.max(0, index - context);
          const lastLine = Math.min(lines.length - 1, index + context);
          const match = {
            path: candidate,
            lineNumber: index + 1,
            lineText: line.slice(0, 4000),
            lines: lines.slice(firstLine, lastLine + 1).map((item) => item.slice(0, 4000)),
            firstLine: firstLine + 1,
          };
          const matchBytes = Buffer.byteLength(JSON.stringify(match), 'utf8') + 1;
          if (resultBytes + matchBytes > MAX_RESULT_PAYLOAD_BYTES) {
            truncated = true;
            break search;
          }
          matches.push(match);
          resultBytes += matchBytes;
        }
      }
      return { matches, truncated: truncated || matches.length >= limit || walked < candidateFiles.length };
    }
    default:
      throw new Error('Unsupported sandboxed Pi file operation.');
  }
}

async function readRequest(): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('Sandbox helper request is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
}

if (require.main === module) {
  void readRequest().then(run).then((result) => {
    const payload = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(payload, 'utf8') > MAX_RESULT_BYTES) throw new Error('Sandbox helper result is too large.');
    process.stdout.write(payload);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Sandbox helper operation failed.';
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  });
}
