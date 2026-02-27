/**
 * Orchestrate all validation gates and produce a unified report.
 *
 * Runs each checker in sequence and aggregates results into a single
 * pass/fail summary printed via the project logger.
 */

import { logger } from '../utils/logger.js';
import { checkMdxFiles } from './mdx-parser-check.js';
import { checkLinks } from './link-checker.js';
import { checkNavigation } from './nav-integrity.js';
import { checkImages } from './image-checker.js';
import { checkBranding } from './branding-checker.js';

// ── Public Types ──────────────────────────────────────────────────────

/**
 * Result from a single validation checker.
 */
export interface ValidationResult {
  passed: boolean;
  errors: Array<{ file?: string; error: string; [key: string]: unknown }>;
}

/**
 * Aggregated result from running all validation checkers.
 */
export interface FullValidationResult {
  passed: boolean;
  results: Record<string, ValidationResult>;
  summary: string;
}

// ── Runner ────────────────────────────────────────────────────────────

/**
 * Run all validation checkers against `outputDir` and return the
 * aggregated result.
 */
export async function runValidation(outputDir: string): Promise<FullValidationResult> {
  logger.info('Running validation checks...');

  const results: Record<string, ValidationResult> = {};

  // 1. MDX parsing
  logger.info('  Checking MDX file parsing...');
  results['mdx-parser'] = await checkMdxFiles(outputDir);
  logCheckResult('MDX Parser', results['mdx-parser']);

  // 2. Internal links
  logger.info('  Checking internal links...');
  results['links'] = await checkLinks(outputDir);
  logCheckResult('Internal Links', results['links']);

  // 3. Navigation integrity
  logger.info('  Checking navigation integrity...');
  results['navigation'] = await checkNavigation(outputDir);
  logCheckResult('Navigation Integrity', results['navigation']);

  // 4. Image references
  logger.info('  Checking image references...');
  results['images'] = await checkImages(outputDir);
  logCheckResult('Image References', results['images']);

  // 5. Branding completeness
  logger.info('  Checking branding completeness...');
  results['branding'] = await checkBranding(outputDir);
  logCheckResult('Branding', results['branding']);

  // Compute overall pass/fail.
  const passed = Object.values(results).every((r) => r.passed);

  // Build summary string.
  const lines: string[] = [];
  lines.push('');
  lines.push('Validation Summary');
  lines.push('──────────────────');

  for (const [name, result] of Object.entries(results)) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const errorCount = result.errors.length;
    const detail = errorCount > 0 ? ` (${errorCount} error${errorCount > 1 ? 's' : ''})` : '';
    lines.push(`  ${status}  ${name}${detail}`);
  }

  lines.push('──────────────────');
  lines.push(passed ? 'All checks passed.' : 'Some checks failed. See errors above.');

  const summary = lines.join('\n');

  // Print summary.
  if (passed) {
    logger.success(summary);
  } else {
    logger.warn(summary);
  }

  return { passed, results, summary };
}

// ── Internals ─────────────────────────────────────────────────────────

/**
 * Log the result of a single check, including any errors.
 */
function logCheckResult(label: string, result: ValidationResult): void {
  if (result.passed) {
    logger.success(`    ${label}: passed`);
  } else {
    logger.error(`    ${label}: ${result.errors.length} error(s)`);
    for (const err of result.errors) {
      const location = err.file ? ` [${err.file}]` : '';
      logger.error(`      - ${err.error}${location}`);
    }
  }
}
