import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';
import type { GitBookFile, ImageAsset, ParsedPage } from '../types.js';

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Build a unified asset inventory by cross-referencing three sources:
 *
 *   1. **API file manifest** -- files the GitBook API reports as
 *      belonging to the space.
 *   2. **Markdown references** -- image paths extracted during page
 *      parsing.
 *   3. **Source repo** -- actual files present under `.gitbook/assets/`
 *      in the local checkout.
 *
 * Each source contributes what it knows and the result is a single list
 * of `ImageAsset` entries with status flags indicating where each asset
 * was found.
 */
export async function buildAssetInventory(
  apiFiles: GitBookFile[],
  parsedPages: ParsedPage[],
  sourceDir?: string,
): Promise<ImageAsset[]> {
  // ── Phase 1: collect references from parsed pages ──────────────────
  const referencedImages = collectImageReferences(parsedPages);

  // ── Phase 2: index API files ───────────────────────────────────────
  const apiFileIndex = indexApiFiles(apiFiles);

  // ── Phase 3: scan local .gitbook/assets/ directory ─────────────────
  const repoFiles = sourceDir
    ? await scanGitBookAssets(sourceDir)
    : new Set<string>();

  // ── Phase 4: merge into unified inventory ──────────────────────────
  const assetMap = new Map<string, ImageAsset>();

  // Start with everything referenced in markdown.
  for (const [sourcePath, referencedIn] of referencedImages) {
    const normalized = normalizePath(sourcePath);
    const apiEntry = findApiMatch(normalized, apiFileIndex);

    assetMap.set(normalized, {
      sourcePath,
      referencedIn: [...referencedIn],
      foundInRepo: repoFiles.has(normalized),
      foundInApi: apiEntry !== undefined,
      apiDownloadUrl: apiEntry?.downloadURL,
      targetPath: computeTargetPath(sourcePath),
    });
  }

  // Add API files that were not referenced in any page.
  for (const apiFile of apiFiles) {
    if (!apiFile.contentType?.startsWith('image/')) continue;

    const normalized = normalizePath(apiFile.name);
    if (!assetMap.has(normalized)) {
      assetMap.set(normalized, {
        sourcePath: apiFile.name,
        referencedIn: [],
        foundInRepo: repoFiles.has(normalized),
        foundInApi: true,
        apiDownloadUrl: apiFile.downloadURL,
        targetPath: computeTargetPath(apiFile.name),
      });
    }
  }

  // Add repo files that were neither referenced nor in the API.
  for (const repoPath of repoFiles) {
    if (!assetMap.has(repoPath)) {
      assetMap.set(repoPath, {
        sourcePath: repoPath,
        referencedIn: [],
        foundInRepo: true,
        foundInApi: false,
        targetPath: computeTargetPath(repoPath),
      });
    }
  }

  const assets = [...assetMap.values()];

  logInventorySummary(assets);

  return assets;
}

/**
 * Categorize assets into actionable buckets for the migration pipeline.
 */
export function categorizeAssets(assets: ImageAsset[]): {
  toDownload: ImageAsset[];
  toCopy: ImageAsset[];
  orphaned: ImageAsset[];
  missing: ImageAsset[];
} {
  const toDownload: ImageAsset[] = [];
  const toCopy: ImageAsset[] = [];
  const orphaned: ImageAsset[] = [];
  const missing: ImageAsset[] = [];

  for (const asset of assets) {
    const isReferenced = asset.referencedIn.length > 0;

    if (!isReferenced) {
      // Present somewhere but never referenced in markdown.
      orphaned.push(asset);
    } else if (!asset.foundInRepo && !asset.foundInApi) {
      // Referenced but cannot be found anywhere.
      missing.push(asset);
    } else if (asset.foundInRepo) {
      // Available locally -- can be copied directly.
      toCopy.push(asset);
    } else if (asset.foundInApi && asset.apiDownloadUrl) {
      // Not available locally but downloadable from the API.
      toDownload.push(asset);
    } else {
      // Referenced and in the API manifest but no download URL.
      missing.push(asset);
    }
  }

  return { toDownload, toCopy, orphaned, missing };
}

// ─── Internal helpers ──────────────────────────────────────────────────

/**
 * Walk all parsed pages and collect a map from image source path to the
 * set of pages that reference it.
 */
function collectImageReferences(
  pages: ParsedPage[],
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();

  for (const page of pages) {
    for (const img of page.images) {
      // Skip external URLs.
      if (/^https?:\/\//.test(img)) continue;

      const normalized = normalizePath(img);
      if (!refs.has(normalized)) {
        refs.set(normalized, new Set());
      }
      refs.get(normalized)!.add(page.path);
    }
  }

  return refs;
}

/**
 * Build an index of API files keyed by their normalized name for quick
 * lookup.
 */
function indexApiFiles(
  apiFiles: GitBookFile[],
): Map<string, GitBookFile> {
  const index = new Map<string, GitBookFile>();
  for (const file of apiFiles) {
    if (file.contentType?.startsWith('image/') || isImageExtension(file.name)) {
      index.set(normalizePath(file.name), file);
    }
  }
  return index;
}

/**
 * Try to find a matching API file entry for a referenced image path.
 *
 * References in markdown may use slightly different path forms than the
 * API reports, so we try several normalization strategies.
 */
function findApiMatch(
  normalizedPath: string,
  apiFileIndex: Map<string, GitBookFile>,
): GitBookFile | undefined {
  // Direct match.
  if (apiFileIndex.has(normalizedPath)) {
    return apiFileIndex.get(normalizedPath);
  }

  // Try matching by filename only (references sometimes omit directory
  // prefixes).
  const basename = normalizedPath.split('/').pop() ?? '';
  for (const [key, file] of apiFileIndex) {
    if (key.endsWith('/' + basename) || key === basename) {
      return file;
    }
  }

  return undefined;
}

/**
 * Scan the `.gitbook/assets/` directory (if it exists) and return a set
 * of normalized relative paths.
 */
async function scanGitBookAssets(sourceDir: string): Promise<Set<string>> {
  const assetsDir = path.join(sourceDir, '.gitbook', 'assets');
  const result = new Set<string>();

  try {
    await fs.access(assetsDir);
  } catch {
    logger.debug(`No .gitbook/assets/ directory found at ${assetsDir}`);
    return result;
  }

  const entries = await fs.readdir(assetsDir, { recursive: true });

  for (const entry of entries) {
    const entryStr = typeof entry === 'string' ? entry : String(entry);
    const fullPath = path.join(assetsDir, entryStr);

    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        const relativePath = `.gitbook/assets/${entryStr}`;
        result.add(normalizePath(relativePath));
      }
    } catch {
      // Skip entries we cannot stat.
    }
  }

  logger.debug(`Found ${result.size} file(s) in .gitbook/assets/`);

  return result;
}

/**
 * Compute the Mintlify target path for an asset.
 *
 * GitBook assets typically live under `.gitbook/assets/` and we relocate
 * them to `/images/` with a sanitized filename.
 */
function computeTargetPath(sourcePath: string): string {
  // Extract just the filename.
  const basename = sourcePath.split('/').pop() ?? sourcePath;

  // Sanitize: replace spaces and special chars with hyphens, lowercase.
  const sanitized = basename
    .replace(/[%\s]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  return `/images/${sanitized}`;
}

/**
 * Check whether a filename has a common image extension.
 */
function isImageExtension(filename: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?)$/i.test(filename);
}

/**
 * Log a summary of the inventory for debugging.
 */
function logInventorySummary(assets: ImageAsset[]): void {
  const referenced = assets.filter((a) => a.referencedIn.length > 0);
  const inRepo = assets.filter((a) => a.foundInRepo);
  const inApi = assets.filter((a) => a.foundInApi);

  logger.debug(
    `Asset inventory: ${assets.length} total, ` +
      `${referenced.length} referenced, ` +
      `${inRepo.length} in repo, ` +
      `${inApi.length} in API`,
  );
}

// ─── Utilities ─────────────────────────────────────────────────────────

/**
 * Normalize a path for consistent comparison: decode URI components,
 * collapse slashes, strip leading `./` and trailing `/`.
 */
function normalizePath(p: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    decoded = p;
  }

  return decoded
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}
