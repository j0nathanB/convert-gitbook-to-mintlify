import { logger } from '../utils/logger.js';
import type { NavGroup, NavPage, NavTab } from '../types.js';

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Disambiguate the "parent-with-children" pattern that GitBook allows
 * but Mintlify does not.
 *
 * In GitBook a page can have its own content *and* child pages.  Mintlify
 * uses a strict group/page hierarchy where a nav group cannot also be a
 * navigable page.  This function resolves the conflict:
 *
 *   1. The parent's content becomes an "overview" page at
 *      `<parent-slug>/overview`.
 *   2. The parent's label becomes a Mintlify nav group name.
 *   3. The overview page is inserted as the first child of that group.
 *   4. A redirect is emitted from the original parent path to the new
 *      overview path.
 */
export function disambiguateSlugs(tabs: NavTab[]): {
  tabs: NavTab[];
  redirects: Array<{ source: string; destination: string }>;
} {
  const redirects: Array<{ source: string; destination: string }> = [];

  const disambiguatedTabs = tabs.map((tab) => ({
    ...tab,
    groups: disambiguateGroups(tab.groups, redirects),
  }));

  return { tabs: disambiguatedTabs, redirects };
}

// ─── Internal helpers ──────────────────────────────────────────────────

/**
 * Walk groups recursively.  For each page that has children (represented
 * as a sub-group whose label matches the page label), convert the page
 * into an overview entry inside the sub-group.
 */
function disambiguateGroups(
  groups: NavGroup[],
  redirects: Array<{ source: string; destination: string }>,
): NavGroup[] {
  return groups.map((group) => {
    const newPages: NavPage[] = [];
    let newSubGroups: NavGroup[] = group.groups
      ? [...group.groups]
      : [];

    for (const page of group.pages) {
      // Determine whether this page acts as a parent-with-children.
      // Convention: a matching sub-group shares the page's label.
      const childGroupIdx = newSubGroups.findIndex(
        (g) => g.label.toLowerCase() === page.label.toLowerCase(),
      );

      if (childGroupIdx !== -1) {
        const childGroup = newSubGroups[childGroupIdx];
        const overviewSlug = buildOverviewSlug(page.path);

        logger.debug(
          `Disambiguating parent page "${page.label}" → ${overviewSlug}`,
        );

        // Build the overview page entry.
        const overviewPage: NavPage = {
          label: 'Overview',
          path: overviewSlug,
          outputPath: overviewSlug,
        };

        // Insert overview as first child of the existing sub-group.
        const updatedSubGroup: NavGroup = {
          label: childGroup.label,
          pages: [overviewPage, ...childGroup.pages],
          groups: childGroup.groups,
        };

        // Replace the old sub-group in the array.
        newSubGroups[childGroupIdx] = updatedSubGroup;

        // Emit a redirect from the old parent path to the overview.
        redirects.push({
          source: ensureLeadingSlash(page.path),
          destination: ensureLeadingSlash(overviewSlug),
        });
      } else if (hasNestedContent(page, newSubGroups)) {
        // Fallback: the page path itself implies parent status (e.g. it
        // matches a sub-group slug prefix).  Create a new sub-group.
        const overviewSlug = buildOverviewSlug(page.path);

        const overviewPage: NavPage = {
          label: 'Overview',
          path: overviewSlug,
          outputPath: overviewSlug,
        };

        // Collect child pages whose paths are nested under this parent.
        const childPages = extractChildPages(page.path, group.pages);
        if (childPages.length > 0) {
          logger.debug(
            `Creating sub-group for parent "${page.label}" with ${childPages.length} child page(s)`,
          );

          const subGroup: NavGroup = {
            label: page.label,
            pages: [overviewPage, ...childPages],
          };

          newSubGroups.push(subGroup);

          redirects.push({
            source: ensureLeadingSlash(page.path),
            destination: ensureLeadingSlash(overviewSlug),
          });

          // Skip adding the parent page to newPages; it is now the group.
          continue;
        }

        // If no nested children were found, keep the page as-is.
        newPages.push(page);
      } else {
        newPages.push(page);
      }
    }

    // Recursively process sub-groups.
    newSubGroups = disambiguateGroups(newSubGroups, redirects);

    return {
      label: group.label,
      pages: newPages,
      groups: newSubGroups.length > 0 ? newSubGroups : undefined,
    };
  });
}

/**
 * Build the overview slug for a parent page.
 *
 * `getting-started` → `getting-started/overview`
 * `guides/setup`    → `guides/setup/overview`
 */
function buildOverviewSlug(parentPath: string): string {
  const stripped = stripMdExtension(parentPath).replace(/\/+$/, '');
  return `${stripped}/overview`;
}

/**
 * Determine whether a page has nested content based on path prefixes in
 * existing sub-groups.
 */
function hasNestedContent(
  page: NavPage,
  subGroups: NavGroup[],
): boolean {
  const prefix = stripMdExtension(page.path)
    .replace(/\/+$/, '')
    .toLowerCase();

  return subGroups.some((g) =>
    g.pages.some((p) =>
      stripMdExtension(p.path).toLowerCase().startsWith(prefix + '/'),
    ),
  );
}

/**
 * Extract pages from a flat list whose paths are nested under the given
 * parent path.
 */
function extractChildPages(
  parentPath: string,
  pages: NavPage[],
): NavPage[] {
  const prefix = stripMdExtension(parentPath)
    .replace(/\/+$/, '')
    .toLowerCase();

  return pages.filter((p) =>
    stripMdExtension(p.path).toLowerCase().startsWith(prefix + '/'),
  );
}

// ─── Utilities ─────────────────────────────────────────────────────────

function stripMdExtension(p: string): string {
  return p.replace(/\.mdx?$/, '');
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}
