import { isPiPackageSource } from './package-source';

const MAX_PACKAGE_RECOMMENDATION_RESPONSE_BYTES = 128 * 1024;

const RECOMMENDED_PI_PACKAGES = [
  { name: 'pi-subagents', reason: 'Delegate independent tasks to focused child agents.' },
  { name: '@inobit/pi-todo', reason: 'Track multi-step work with a persistent task list.' },
  { name: '@plannotator/pi-extension', reason: 'Review and annotate implementation plans.' },
] as const;

export type RecommendedPiPackage = {
  name: string;
  version: string;
  description: string;
  source: string;
  recommendation: string;
};

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_PACKAGE_RECOMMENDATION_RESPONSE_BYTES) {
    throw new Error('The package metadata is too large.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The package metadata was empty.');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PACKAGE_RECOMMENDATION_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('The package metadata is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

async function fetchRecommendedPiPackage(
  recommendation: (typeof RECOMMENDED_PI_PACKAGES)[number],
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<RecommendedPiPackage | undefined> {
  const packagePath = `/${recommendation.name.split('/').map(encodeURIComponent).join('/')}/latest`;
  const url = new URL(packagePath, 'https://registry.npmjs.org');
  const response = await fetcher(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    signal,
  });
  let responseUrl: URL;
  let responsePath: string;
  try {
    responseUrl = new URL(response.url);
    responsePath = decodeURIComponent(responseUrl.pathname);
  } catch {
    return undefined;
  }
  if (responseUrl.origin !== 'https://registry.npmjs.org'
    || responsePath !== `/${recommendation.name}/latest`
    || !response.ok) return undefined;

  const payload = await readBoundedJsonResponse(response);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const fields = payload as Record<string, unknown>;
  const version = typeof fields.version === 'string' ? fields.version : '';
  const keywords = Array.isArray(fields.keywords) ? fields.keywords : [];
  const hasPiPackageKeyword = keywords.some((keyword) => typeof keyword === 'string' && keyword.toLowerCase() === 'pi-package');
  if (fields.name !== recommendation.name
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    || !hasPiPackageKeyword) return undefined;
  const source = `npm:${recommendation.name}@${version}`;
  if (!isPiPackageSource(source)) return undefined;
  const description = typeof fields.description === 'string'
    ? fields.description.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
    : '';
  return { name: recommendation.name, version, source, description, recommendation: recommendation.reason };
}

export async function loadRecommendedPiPackages(fetcher: typeof fetch, signal: AbortSignal): Promise<RecommendedPiPackage[]> {
  const results = await Promise.all(RECOMMENDED_PI_PACKAGES.map(async (item) => {
    try {
      return await fetchRecommendedPiPackage(item, fetcher, signal);
    } catch {
      return undefined;
    }
  }));
  return results.filter((item): item is RecommendedPiPackage => Boolean(item));
}
