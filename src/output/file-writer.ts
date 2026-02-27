import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname, extname, basename } from 'node:path';

import type { DocsJson, MigrationReport, ImageAsset } from '../types.js';
import { logger } from '../utils/logger.js';
import { writeDocsJson } from './docs-json.js';
import { writeReportFiles } from './report-generator.js';

// ── Filename normalization ───────────────────────────────────────────

/**
 * Convert a filename to kebab-case, stripping special characters.
 *
 * Examples:
 *   "Getting Started"  → "getting-started"
 *   "My Page (draft)"  → "my-page-draft"
 *   "API_Reference_v2" → "api-reference-v2"
 *   "  foo  BAR  baz " → "foo-bar-baz"
 */
export function normalizeFilename(name: string): string {
  return (
    name
      // Replace any non-alphanumeric, non-hyphen, non-period characters with
      // hyphens (this handles spaces, underscores, and special chars)
      .replace(/[^a-zA-Z0-9.\-]+/g, '-')
      // Collapse multiple consecutive hyphens
      .replace(/-{2,}/g, '-')
      // Strip leading/trailing hyphens
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}

/**
 * Normalize an output path, converting the filename portion to kebab-case
 * while preserving the directory structure and extension.
 */
function normalizeOutputPath(outputPath: string): string {
  const dir = dirname(outputPath);
  const ext = extname(outputPath);
  const base = basename(outputPath, ext);
  const normalized = normalizeFilename(base) + ext;
  return dir === '.' ? normalized : join(dir, normalized);
}

// ── Public API ───────────────────────────────────────────────────────

export interface WriteOutputFilesOptions {
  outputDir: string;
  pages: Array<{ outputPath: string; content: string }>;
  docsJson: DocsJson;
  report: MigrationReport;
  assets: ImageAsset[];
}

/**
 * Write all output files to disk:
 *
 *   output/docs.json
 *   output/logo/            (light.svg, dark.svg — written elsewhere)
 *   output/images/           (migrated image assets)
 *   output/[section]/[page].mdx
 *   output/_migration/       (report.json, discrepancies.md, etc.)
 */
export async function writeOutputFiles(
  options: WriteOutputFilesOptions,
): Promise<void> {
  const { outputDir, pages, docsJson, report, assets } = options;

  // ── Create base directories ──────────────────────────────────────
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, 'logo'), { recursive: true });
  await mkdir(join(outputDir, 'images'), { recursive: true });
  await mkdir(join(outputDir, '_migration'), { recursive: true });

  // ── docs.json ────────────────────────────────────────────────────
  await writeDocsJson(docsJson, outputDir);

  // ── MDX pages ────────────────────────────────────────────────────
  let pagesWritten = 0;
  for (const page of pages) {
    const normalized = normalizeOutputPath(page.outputPath);
    const fullPath = join(outputDir, normalized);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, page.content, 'utf-8');
    pagesWritten++;
  }
  logger.info(`Wrote ${pagesWritten} page(s)`);

  // ── Image assets ─────────────────────────────────────────────────
  let assetsCopied = 0;
  for (const asset of assets) {
    if (asset.foundInRepo && asset.sourcePath) {
      try {
        const targetFull = join(outputDir, asset.targetPath);
        await mkdir(dirname(targetFull), { recursive: true });
        await copyFile(asset.sourcePath, targetFull);
        assetsCopied++;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to copy asset ${asset.sourcePath}: ${msg}`);
      }
    }
  }
  if (assetsCopied > 0) {
    logger.info(`Copied ${assetsCopied} local image asset(s)`);
  }

  // ── Migration reports ────────────────────────────────────────────
  await writeReportFiles(report, outputDir);

  logger.success(`Output written to ${outputDir}`);
}
