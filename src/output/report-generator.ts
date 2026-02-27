import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  MigrationReport,
  Discrepancy,
  ManualReviewItem,
} from '../types.js';
import { logger } from '../utils/logger.js';

// ── Default report ───────────────────────────────────────────────────

/**
 * Fill in defaults for any missing fields in a partial migration report.
 */
export function generateReport(data: Partial<MigrationReport>): MigrationReport {
  return {
    stats: {
      totalPages: data.stats?.totalPages ?? 0,
      imagesCopied: data.stats?.imagesCopied ?? 0,
      imagesDownloaded: data.stats?.imagesDownloaded ?? 0,
      linksRewritten: data.stats?.linksRewritten ?? 0,
      redirectsPreserved: data.stats?.redirectsPreserved ?? 0,
      blocksConverted: data.stats?.blocksConverted ?? 0,
      blocksUnrecognized: data.stats?.blocksUnrecognized ?? 0,
    },
    dataSources: {
      api: data.dataSources?.api ?? false,
      sourceFiles: data.dataSources?.sourceFiles ?? false,
      scraper: data.dataSources?.scraper ?? false,
    },
    discrepancies: data.discrepancies ?? [],
    warnings: data.warnings ?? [],
    brandingSource: data.brandingSource ?? {},
    manualReviewQueue: data.manualReviewQueue ?? [],
  };
}

// ── Report file writers ──────────────────────────────────────────────

/**
 * Write all migration report files into `outputDir/_migration/`.
 *
 * Generates four files:
 *   - report.json         — full report as JSON
 *   - discrepancies.md    — formatted list of nav mismatches and broken links
 *   - manual-review.md    — items needing human attention, ordered by severity
 *   - block-inventory.json — all GitBook blocks and their conversion status
 */
export async function writeReportFiles(
  report: MigrationReport,
  outputDir: string,
): Promise<void> {
  const migrationDir = join(outputDir, '_migration');
  await mkdir(migrationDir, { recursive: true });

  // ── report.json ──────────────────────────────────────────────────
  const reportPath = join(migrationDir, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify(report, null, 2) + '\n',
    'utf-8',
  );

  // ── discrepancies.md ─────────────────────────────────────────────
  const discrepanciesPath = join(migrationDir, 'discrepancies.md');
  const discrepanciesContent = formatDiscrepancies(report.discrepancies);
  await writeFile(discrepanciesPath, discrepanciesContent, 'utf-8');

  // ── manual-review.md ─────────────────────────────────────────────
  const manualReviewPath = join(migrationDir, 'manual-review.md');
  const manualReviewContent = formatManualReview(report.manualReviewQueue);
  await writeFile(manualReviewPath, manualReviewContent, 'utf-8');

  // ── block-inventory.json ─────────────────────────────────────────
  const blockInventoryPath = join(migrationDir, 'block-inventory.json');
  const blockInventory = buildBlockInventory(report);
  await writeFile(
    blockInventoryPath,
    JSON.stringify(blockInventory, null, 2) + '\n',
    'utf-8',
  );

  logger.info(`Migration reports written to ${migrationDir}`);
}

// ── Formatters ───────────────────────────────────────────────────────

/**
 * Build a markdown document listing all navigation discrepancies.
 */
function formatDiscrepancies(discrepancies: Discrepancy[]): string {
  const lines: string[] = [
    '# Migration Discrepancies',
    '',
    `Found ${discrepancies.length} discrepancy(ies).`,
    '',
  ];

  if (discrepancies.length === 0) {
    lines.push('No discrepancies detected.');
    lines.push('');
    return lines.join('\n');
  }

  // Group by type
  const grouped = new Map<string, Discrepancy[]>();
  for (const d of discrepancies) {
    const existing = grouped.get(d.type) ?? [];
    existing.push(d);
    grouped.set(d.type, existing);
  }

  for (const [type, items] of grouped) {
    lines.push(`## ${formatDiscrepancyType(type)}`);
    lines.push('');
    for (const item of items) {
      lines.push(`- **${item.path}**: ${item.details}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Human-readable label for a discrepancy type.
 */
function formatDiscrepancyType(type: string): string {
  switch (type) {
    case 'label_mismatch':
      return 'Label Mismatches';
    case 'orphan':
      return 'Orphaned Pages';
    case 'missing_in_source':
      return 'Missing in Source';
    case 'draft':
      return 'Draft Pages';
    default:
      return type;
  }
}

/**
 * Build a markdown document listing manual review items, sorted by
 * severity (high > medium > low).
 */
function formatManualReview(items: ManualReviewItem[]): string {
  const lines: string[] = [
    '# Manual Review Required',
    '',
    `${items.length} item(s) require manual review.`,
    '',
  ];

  if (items.length === 0) {
    lines.push('No items require manual review.');
    lines.push('');
    return lines.join('\n');
  }

  // Sort by severity priority
  const severityOrder: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  const sorted = [...items].sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );

  let currentSeverity = '';
  for (const item of sorted) {
    if (item.severity !== currentSeverity) {
      currentSeverity = item.severity;
      lines.push(`## ${currentSeverity.charAt(0).toUpperCase() + currentSeverity.slice(1)} Severity`);
      lines.push('');
    }
    lines.push(`- [ ] **${item.path}**: ${item.reason}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Build a block inventory from the report warnings.
 *
 * Groups blocks into "converted" and "unrecognized" categories based
 * on the report stats and warnings.
 */
function buildBlockInventory(
  report: MigrationReport,
): Record<string, unknown> {
  const converted: Record<string, number> = {};
  const unrecognized: Record<string, { count: number; paths: string[] }> = {};

  for (const warning of report.warnings) {
    if (warning.type === 'unrecognized_block') {
      // Extract block type from the warning message (convention: "Unrecognized block: <type>")
      const blockType = extractBlockType(warning.message);
      if (!unrecognized[blockType]) {
        unrecognized[blockType] = { count: 0, paths: [] };
      }
      unrecognized[blockType].count++;
      if (warning.path && !unrecognized[blockType].paths.includes(warning.path)) {
        unrecognized[blockType].paths.push(warning.path);
      }
    } else if (warning.type === 'block_converted') {
      const blockType = extractBlockType(warning.message);
      converted[blockType] = (converted[blockType] ?? 0) + 1;
    }
  }

  return {
    summary: {
      totalConverted: report.stats.blocksConverted,
      totalUnrecognized: report.stats.blocksUnrecognized,
    },
    converted,
    unrecognized,
  };
}

/**
 * Best-effort extraction of a block type name from a warning message.
 */
function extractBlockType(message: string): string {
  // Try patterns like "Unrecognized block: tabs" or "Converted block: hint"
  const match = message.match(/block[:\s]+(\S+)/i);
  return match?.[1] ?? 'unknown';
}
