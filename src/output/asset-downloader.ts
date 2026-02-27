import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import type { GitBookCustomization } from '../types.js';
import { fetchWithRetry } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { parseCdnUrl } from '../transformer/cdn-url-parser.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Map of common content-type values to file extensions.
 */
const CONTENT_TYPE_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/avif': '.avif',
};

/**
 * Determine the file extension for a downloaded asset by inspecting the
 * response content-type header and falling back to the URL extension.
 */
function resolveExtension(url: string, contentType?: string | null): string {
  // Try content-type first
  if (contentType) {
    const mimeBase = contentType.split(';')[0].trim().toLowerCase();
    const mapped = CONTENT_TYPE_MAP[mimeBase];
    if (mapped) return mapped;
  }

  // Fall back to URL extension
  try {
    const { pathname } = new URL(url);
    const ext = extname(pathname).toLowerCase();
    if (ext) return ext;
  } catch {
    // URL may not be parseable — try a simple split
    const ext = extname(url.split('?')[0]).toLowerCase();
    if (ext) return ext;
  }

  return '.png'; // safe fallback
}

// ── Single asset download ────────────────────────────────────────────

/**
 * Download a single asset from a URL and write it to `targetPath`.
 *
 * Uses `fetchWithRetry` for resilience against transient failures.
 */
export async function downloadAsset(
  url: string,
  targetPath: string,
): Promise<void> {
  // Resolve GitBook CDN URLs to their originals
  const cdnResult = parseCdnUrl(url);
  const resolvedUrl = cdnResult ? cdnResult.originalUrl : url;

  const response = await fetchWithRetry(resolvedUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to download ${resolvedUrl}: HTTP ${response.status}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, buffer);
}

// ── Batch download ───────────────────────────────────────────────────

/**
 * Download multiple assets concurrently in batches of `batchSize`.
 *
 * Returns a summary of how many succeeded and which URLs failed.
 */
export async function downloadAssets(
  assets: Array<{ url: string; targetPath: string }>,
  batchSize = 8,
): Promise<{ downloaded: number; failed: string[] }> {
  let downloaded = 0;
  const failed: string[] = [];

  for (let i = 0; i < assets.length; i += batchSize) {
    const batch = assets.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async ({ url, targetPath }) => {
        await downloadAsset(url, targetPath);
        return url;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        downloaded++;
      } else {
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        // Extract the URL from the batch entry that corresponds to this result
        const idx = results.indexOf(result);
        const failedUrl = batch[idx]?.url ?? 'unknown';
        failed.push(failedUrl);
        logger.warn(`Asset download failed: ${reason}`);
      }
    }
  }

  return { downloaded, failed };
}

// ── Logo / favicon download ──────────────────────────────────────────

export interface LogoDownloadResult {
  lightLogo?: string;
  darkLogo?: string;
  favicon?: string;
}

/**
 * Download logos and favicon from the GitBook customization to the
 * output directory.
 *
 * Returns the relative paths (from outputDir) for each successfully
 * downloaded asset.
 */
export async function downloadLogos(
  customization: GitBookCustomization | null,
  outputDir: string,
): Promise<LogoDownloadResult> {
  const result: LogoDownloadResult = {};
  const logoDir = join(outputDir, 'logo');

  // ── Light logo ───────────────────────────────────────────────────
  const lightUrl = customization?.header?.logo?.light;
  if (lightUrl) {
    try {
      const ext = await downloadAndDetectExtension(
        lightUrl,
        join(logoDir, 'light'),
      );
      result.lightLogo = `/logo/light${ext}`;
      logger.info(`Downloaded light logo to ${result.lightLogo}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to download light logo: ${msg}`);
    }
  }

  // ── Dark logo ────────────────────────────────────────────────────
  const darkUrl = customization?.header?.logo?.dark;
  if (darkUrl) {
    try {
      const ext = await downloadAndDetectExtension(
        darkUrl,
        join(logoDir, 'dark'),
      );
      result.darkLogo = `/logo/dark${ext}`;
      logger.info(`Downloaded dark logo to ${result.darkLogo}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to download dark logo: ${msg}`);
    }
  }

  // ── Favicon ──────────────────────────────────────────────────────
  const faviconRaw = customization?.favicon?.icon;
  const faviconUrl =
    typeof faviconRaw === 'string'
      ? faviconRaw
      : faviconRaw?.light ?? faviconRaw?.dark ?? null;

  if (faviconUrl) {
    try {
      const ext = await downloadAndDetectExtension(
        faviconUrl,
        join(logoDir, 'favicon'),
      );
      result.favicon = `/logo/favicon${ext}`;
      logger.info(`Downloaded favicon to ${result.favicon}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to download favicon: ${msg}`);
    }
  }

  return result;
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Download a URL and determine the correct file extension from the
 * response content-type. The file is written to `basePathWithoutExt`
 * plus the resolved extension. Returns the extension (e.g. `.svg`).
 */
async function downloadAndDetectExtension(
  url: string,
  basePathWithoutExt: string,
): Promise<string> {
  const cdnResult = parseCdnUrl(url);
  const resolvedUrl = cdnResult ? cdnResult.originalUrl : url;

  const response = await fetchWithRetry(resolvedUrl);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${resolvedUrl}`);
  }

  const contentType = response.headers.get('content-type');
  const ext = resolveExtension(resolvedUrl, contentType);

  const buffer = Buffer.from(await response.arrayBuffer());
  const targetPath = `${basePathWithoutExt}${ext}`;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, buffer);

  return ext;
}
