import { logger } from '../utils/logger.js';
import type {
  Discrepancy,
  GitBookSiteStructure,
  MigrationConfig,
  NavGroup,
  NavTab,
} from '../types.js';

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Merge navigation trees from multiple sources into a single unified
 * structure.
 *
 * When the GitBook API structure is available it is treated as the
 * authoritative source of truth and cross-referenced against the
 * SUMMARY.md-derived tabs.  When the API is unavailable the SUMMARY tabs
 * are used directly.
 */
export function mergeNavTrees(
  apiStructure: GitBookSiteStructure | null,
  summaryTabs: NavTab[],
  config: MigrationConfig,
): { tabs: NavTab[]; discrepancies: Discrepancy[] } {
  const discrepancies: Discrepancy[] = [];

  let merged: NavTab[];

  if (apiStructure) {
    merged = mergeWithApi(apiStructure, summaryTabs, discrepancies, config);
  } else {
    logger.debug('No API structure available -- using SUMMARY.md as base');
    merged = structuredClone(summaryTabs);
  }

  // ── Structural validation passes ──────────────────────────────────
  merged = removeEmptyGroups(merged);
  merged = deduplicateTabGroupNames(merged);

  if (config.transforms.flattenSingleChildGroups) {
    merged = flattenSingleChildGroups(merged);
  }

  flagSinglePageTabs(merged, discrepancies);

  return { tabs: merged, discrepancies };
}

// ─── API merge logic ───────────────────────────────────────────────────

function mergeWithApi(
  apiStructure: GitBookSiteStructure,
  summaryTabs: NavTab[],
  discrepancies: Discrepancy[],
  config: MigrationConfig,
): NavTab[] {
  // Build a lookup from the SUMMARY tabs by slug for cross-referencing.
  const summaryBySlug = new Map<string, NavTab>();
  for (const tab of summaryTabs) {
    summaryBySlug.set(tab.slug, tab);
  }

  // Build the set of paths that exist in the API structure so we can
  // detect orphans in SUMMARY.
  const apiPaths = collectApiPaths(apiStructure);

  // Start from the SUMMARY tabs (which contain page content structure)
  // but prefer API display names where available.
  const merged: NavTab[] = [];

  for (const summaryTab of summaryTabs) {
    const tabConfig = Object.values(config.tabs).find(
      (t) => t.slug === summaryTab.slug,
    );

    const tab: NavTab = {
      label: tabConfig?.label ?? summaryTab.label,
      slug: summaryTab.slug,
      sourceFile: summaryTab.sourceFile,
      groups: reconcileGroups(
        summaryTab.groups,
        apiPaths,
        discrepancies,
      ),
    };

    merged.push(tab);
  }

  // Mark any pages present in SUMMARY but absent from API as orphans.
  detectOrphans(summaryTabs, apiPaths, discrepancies);

  return merged;
}

/**
 * Collect all page paths declared in the API site structure so we can
 * cross-reference against SUMMARY content.
 */
function collectApiPaths(apiStructure: GitBookSiteStructure): Set<string> {
  const paths = new Set<string>();

  if (apiStructure.type === 'sections') {
    for (const section of apiStructure.structure) {
      paths.add(section.path);
      for (const space of section.siteSpaces) {
        paths.add(space.path);
      }
    }
  } else {
    for (const space of apiStructure.structure) {
      paths.add(space.path);
    }
  }

  return paths;
}

/**
 * Walk SUMMARY groups and flag any page whose path does not appear in the
 * API path set.
 */
function detectOrphans(
  tabs: NavTab[],
  apiPaths: Set<string>,
  discrepancies: Discrepancy[],
): void {
  for (const tab of tabs) {
    for (const group of tab.groups) {
      detectOrphansInGroup(group, apiPaths, discrepancies);
    }
  }
}

function detectOrphansInGroup(
  group: NavGroup,
  apiPaths: Set<string>,
  discrepancies: Discrepancy[],
): void {
  for (const page of group.pages) {
    // Normalize: strip leading/trailing slashes for comparison.
    const normalized = normalizePath(page.path);
    const matched = [...apiPaths].some(
      (p) => normalizePath(p) === normalized,
    );
    if (!matched) {
      discrepancies.push({
        type: 'orphan',
        path: page.path,
        details: `Page "${page.label}" found in SUMMARY.md but not in API structure`,
      });
    }
  }

  if (group.groups) {
    for (const sub of group.groups) {
      detectOrphansInGroup(sub, apiPaths, discrepancies);
    }
  }
}

/**
 * Reconcile groups from SUMMARY against API paths, preferring API display
 * names where available.
 */
function reconcileGroups(
  groups: NavGroup[],
  apiPaths: Set<string>,
  discrepancies: Discrepancy[],
): NavGroup[] {
  return groups.map((group) => ({
    label: group.label,
    pages: group.pages.map((page) => {
      // Check for label discrepancy when the API path is known.
      const normalized = normalizePath(page.path);
      const apiMatch = [...apiPaths].find(
        (p) => normalizePath(p) === normalized,
      );
      if (apiMatch && apiMatch !== page.path) {
        discrepancies.push({
          type: 'label_mismatch',
          path: page.path,
          details: `SUMMARY label "${page.label}" differs from API path "${apiMatch}"`,
        });
      }
      return { ...page };
    }),
    groups: group.groups
      ? reconcileGroups(group.groups, apiPaths, discrepancies)
      : undefined,
  }));
}

// ─── Structural validation helpers ─────────────────────────────────────

/**
 * Remove groups that contain zero pages and zero sub-groups.
 */
function removeEmptyGroups(tabs: NavTab[]): NavTab[] {
  return tabs.map((tab) => ({
    ...tab,
    groups: pruneEmptyGroups(tab.groups),
  }));
}

function pruneEmptyGroups(groups: NavGroup[]): NavGroup[] {
  const result: NavGroup[] = [];

  for (const group of groups) {
    const subGroups = group.groups
      ? pruneEmptyGroups(group.groups)
      : undefined;

    const hasPages = group.pages.length > 0;
    const hasSubGroups = subGroups !== undefined && subGroups.length > 0;

    if (!hasPages && !hasSubGroups) {
      logger.debug(`Removing empty group "${group.label}"`);
      continue;
    }

    result.push({ ...group, groups: subGroups });
  }

  return result;
}

/**
 * If a tab has exactly one group whose label matches the tab label,
 * the group name is redundant -- strip the group label so Mintlify
 * does not render the same name twice.
 */
function deduplicateTabGroupNames(tabs: NavTab[]): NavTab[] {
  return tabs.map((tab) => {
    if (
      tab.groups.length === 1 &&
      tab.groups[0].label.toLowerCase() === tab.label.toLowerCase()
    ) {
      logger.debug(
        `Tab "${tab.label}" has single group with same name -- deduplicating`,
      );
      return {
        ...tab,
        groups: [{ ...tab.groups[0], label: tab.groups[0].label }],
      };
    }
    return tab;
  });
}

/**
 * Flatten groups that contain exactly one child group and no direct pages
 * by lifting the child's pages into the parent.
 */
function flattenSingleChildGroups(tabs: NavTab[]): NavTab[] {
  return tabs.map((tab) => ({
    ...tab,
    groups: flattenGroups(tab.groups),
  }));
}

function flattenGroups(groups: NavGroup[]): NavGroup[] {
  return groups.map((group) => {
    // Recursively flatten sub-groups first.
    const subGroups = group.groups
      ? flattenGroups(group.groups)
      : undefined;

    // A group that has no pages but exactly one sub-group is a candidate
    // for flattening: lift the sub-group contents up.
    if (
      group.pages.length === 0 &&
      subGroups &&
      subGroups.length === 1
    ) {
      const child = subGroups[0];
      logger.debug(
        `Flattening single-child group "${group.label}" → "${child.label}"`,
      );
      return {
        label: child.label,
        pages: child.pages,
        groups: child.groups,
      };
    }

    return { ...group, groups: subGroups };
  });
}

/**
 * Flag tabs that only have a single page across all groups.  These are
 * likely candidates for merging into another tab.
 */
function flagSinglePageTabs(
  tabs: NavTab[],
  discrepancies: Discrepancy[],
): void {
  for (const tab of tabs) {
    const totalPages = countPages(tab.groups);
    if (totalPages === 1) {
      logger.warn(
        `Tab "${tab.label}" contains only a single page -- consider merging`,
      );
      discrepancies.push({
        type: 'orphan',
        path: tab.slug,
        details: `Tab "${tab.label}" has only one page -- flag for merge`,
      });
    }
  }
}

function countPages(groups: NavGroup[]): number {
  let count = 0;
  for (const group of groups) {
    count += group.pages.length;
    if (group.groups) {
      count += countPages(group.groups);
    }
  }
  return count;
}

// ─── Utilities ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '').toLowerCase();
}
