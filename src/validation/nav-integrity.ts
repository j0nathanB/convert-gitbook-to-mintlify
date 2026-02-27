/**
 * Validate the docs.json navigation structure for integrity.
 *
 * Checks performed:
 *  - Every page path referenced in navigation exists as a .mdx file.
 *  - No tab contains zero groups.
 *  - No tab has only a single page (structural issue).
 *  - No duplicate page paths across the entire navigation.
 *  - Tab URL values match actual directory names on disk.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import type { DocsJson, DocsNavTab, DocsNavGroup } from '../types.js';
import type { ValidationResult } from './runner.js';

/**
 * Validate the navigation structure in docs.json.
 */
export async function checkNavigation(outputDir: string): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = [];

  const docsJsonPath = join(outputDir, 'docs.json');
  let docsJson: DocsJson;

  try {
    const raw = await readFile(docsJsonPath, 'utf-8');
    docsJson = JSON.parse(raw) as DocsJson;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      errors: [{ path: 'docs.json', error: `Failed to read or parse docs.json: ${message}` }],
    };
  }

  const allPagePaths: string[] = [];

  const navItems = docsJson.navigation.tabs ?? [];
  for (const navItem of navItems) {
    if (typeof navItem === 'string') {
      // Top-level page reference.
      allPagePaths.push(navItem);
      checkPageExists(outputDir, navItem, errors);
      continue;
    }

    if (isNavTab(navItem)) {
      validateTab(outputDir, navItem, allPagePaths, errors);
    } else if (isNavGroup(navItem)) {
      collectAndValidateGroupPages(outputDir, navItem, allPagePaths, errors);
    }
  }

  // Check for duplicate page paths.
  const seen = new Set<string>();
  for (const p of allPagePaths) {
    if (seen.has(p)) {
      errors.push({ path: p, error: `Duplicate page path "${p}" in navigation` });
    }
    seen.add(p);
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function isNavTab(item: unknown): item is DocsNavTab {
  return typeof item === 'object' && item !== null && 'tab' in item;
}

function isNavGroup(item: unknown): item is DocsNavGroup {
  return typeof item === 'object' && item !== null && 'group' in item;
}

/**
 * Validate a single navigation tab.
 */
function validateTab(
  outputDir: string,
  tab: DocsNavTab,
  allPagePaths: string[],
  errors: ValidationResult['errors'],
): void {
  // Check: no tab contains zero groups.
  if (!tab.groups || tab.groups.length === 0) {
    errors.push({
      path: tab.tab,
      error: `Tab "${tab.tab}" contains zero groups`,
    });
    return;
  }

  // Check: tab URL values match actual directory names.
  // The tab's slug (if encoded in a 'url' property) should correspond to a
  // real directory.  We infer the slug from the first page path segment.
  if ('url' in tab && typeof (tab as Record<string, unknown>)['url'] === 'string') {
    const tabUrl = (tab as Record<string, unknown>)['url'] as string;
    const dirName = tabUrl.replace(/^\//, '').replace(/\/$/, '');
    if (dirName && !existsSync(join(outputDir, dirName))) {
      errors.push({
        path: tab.tab,
        error: `Tab URL "${tabUrl}" does not match an existing directory "${dirName}"`,
      });
    }
  }

  // Collect all pages within this tab.
  let tabPageCount = 0;
  for (const group of tab.groups) {
    tabPageCount += collectAndValidateGroupPages(outputDir, group, allPagePaths, errors);
  }

  // Check: no tab has only a single page.
  if (tabPageCount === 1) {
    errors.push({
      path: tab.tab,
      error: `Tab "${tab.tab}" contains only a single page`,
    });
  }
}

/**
 * Recursively collect page paths from a navigation group and validate each
 * page file exists.  Returns the total number of pages found.
 */
function collectAndValidateGroupPages(
  outputDir: string,
  group: DocsNavGroup,
  allPagePaths: string[],
  errors: ValidationResult['errors'],
): number {
  let count = 0;

  for (const page of group.pages) {
    if (typeof page === 'string') {
      allPagePaths.push(page);
      checkPageExists(outputDir, page, errors);
      count++;
    } else if (isNavGroup(page)) {
      count += collectAndValidateGroupPages(outputDir, page, allPagePaths, errors);
    }
  }

  return count;
}

/**
 * Verify that a navigation page path corresponds to an actual .mdx file.
 */
function checkPageExists(
  outputDir: string,
  pagePath: string,
  errors: ValidationResult['errors'],
): void {
  const mdxPath = join(outputDir, pagePath + '.mdx');
  if (!existsSync(mdxPath)) {
    errors.push({
      path: pagePath,
      error: `Navigation references "${pagePath}" but ${pagePath}.mdx does not exist`,
    });
  }
}
