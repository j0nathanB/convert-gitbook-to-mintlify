/**
 * Extract the sidebar navigation tree from a live GitBook page.
 *
 * GitBook renders a sidebar `<nav>` containing nested lists of links.
 * Some groups are collapsed by default and only load their children
 * lazily when expanded.  This module iteratively clicks all collapsed
 * toggles over multiple rounds until the full tree has been revealed.
 */

import type { NavTreeNode } from '../types.js';
import type { ScraperSelectors } from './selectors.js';

// Compile-time only.
import type { Page } from 'playwright';

// ── Icon-label cleaning ─────────────────────────────────────────────

/**
 * Strip a lowercase-only icon-name prefix from GitBook labels.
 *
 * GitBook renders icon names as text nodes before the real label,
 * producing strings like `"boltQuickstart"` or `"book-blankDocumentation"`.
 * This function detects the pattern (lowercase/dash prefix followed by
 * an uppercase transition) and returns just the human-readable part.
 */
export function cleanIconLabel(raw: string): string {
  // Match: one or more lowercase/dash chars, then an uppercase letter
  // starting the real label.  E.g. "boltQuickstart" → "Quickstart",
  // "book-blankDocumentation" → "Documentation".
  const m = raw.match(/^[a-z][a-z0-9-]*([A-Z].*)$/);
  return m ? m[1] : raw;
}

/**
 * Recursively clean icon-text prefixed labels in a NavTreeNode tree.
 */
export function cleanNavTreeLabels(nodes: NavTreeNode[]): NavTreeNode[] {
  for (const node of nodes) {
    node.label = cleanIconLabel(node.label);
    if (node.children?.length) {
      cleanNavTreeLabels(node.children);
    }
  }
  return nodes;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Walk the sidebar DOM and return a tree of `NavTreeNode` objects
 * representing the full page hierarchy.
 *
 * @param page - A Playwright `Page` (typed `any` for optional-dep safety).
 * @param selectors - The active selector configuration.
 * @param expansionRounds - Maximum number of expand-all-collapsed rounds
 *   to perform before giving up (default 10).  Each round clicks every
 *   collapsed toggle and waits for new items to appear.
 * @returns The extracted navigation tree.
 */
export async function extractNavigation(
  page: any,
  selectors: ScraperSelectors,
  expansionRounds: number = 10,
): Promise<NavTreeNode[]> {
  const p = page as Page;

  // --- Expand all collapsed sidebar groups ---------------------------
  await expandAllCollapsed(p, selectors, expansionRounds);

  // --- Walk the fully expanded sidebar DOM ---------------------------
  const tree = await buildNavTree(p, selectors);

  // --- Clean icon-text prefixed labels --------------------------------
  cleanNavTreeLabels(tree);

  return tree;
}

// ── Expansion logic ──────────────────────────────────────────────────

/**
 * Resolve the sidebar container selector.  Tries the configured
 * `sidebarNav` first, then falls back to the aside with the most links.
 * Returns the CSS path to use for scoped queries.
 */
async function resolveSidebarSelector(
  page: Page,
  selectors: ScraperSelectors,
): Promise<string> {
  const primary = selectors.sidebarNav;
  const found = await page.$(primary);
  if (found) return primary;

  // Fallback: find aside with most links (same logic as buildNavTree).
  const asideSelector = await page.evaluate(() => {
    const asides = document.querySelectorAll('aside');
    let bestIdx = -1;
    let bestCount = 0;
    for (let i = 0; i < asides.length; i++) {
      const count = asides[i].querySelectorAll('a[href]').length;
      if (count > bestCount) {
        bestCount = count;
        bestIdx = i;
      }
    }
    return bestIdx >= 0 && bestCount >= 2 ? `aside:nth-of-type(${bestIdx + 1})` : null;
  });

  return asideSelector ?? primary;
}

/**
 * Iteratively click collapsed sidebar toggles until no new items appear
 * or `maxRounds` is exhausted.
 */
async function expandAllCollapsed(
  page: Page,
  selectors: ScraperSelectors,
  maxRounds: number,
): Promise<void> {
  const container = await resolveSidebarSelector(page, selectors);
  let previousItemCount = 0;

  for (let round = 0; round < maxRounds; round++) {
    // Count how many sidebar items exist right now.
    const currentItemCount = await countSidebarItems(page, container);

    // Find all collapsed toggles (aria-expanded="false").
    const collapsedToggles = await page.$$(
      `${container} ${selectors.collapsibleToggle}[aria-expanded="false"]`,
    );

    if (collapsedToggles.length === 0) {
      // Nothing left to expand.
      break;
    }

    // Click every collapsed toggle.
    for (const toggle of collapsedToggles) {
      try {
        await toggle.click({ timeout: 2000 });
      } catch {
        // Ignore click errors (element may have been removed by a
        // prior expansion).
      }
    }

    // Wait for new items to appear (or a short timeout).
    try {
      await page.waitForTimeout(500);
    } catch {
      // Ignore timeout errors.
    }

    const newItemCount = await countSidebarItems(page, container);

    // If no new items appeared, we are done.
    if (newItemCount <= previousItemCount && round > 0) {
      break;
    }

    previousItemCount = newItemCount;
  }
}

/**
 * Count the current number of sidebar link items.
 */
async function countSidebarItems(
  page: Page,
  containerSelector: string,
): Promise<number> {
  return page.$$eval(
    `${containerSelector} a[href]`,
    (els: Element[]) => els.length,
  );
}

// ── Tree construction ────────────────────────────────────────────────

/**
 * Parse the fully-expanded sidebar DOM into a `NavTreeNode[]` tree.
 *
 * The extraction runs entirely inside `page.evaluate` to minimise
 * round-trips between Node and the browser.
 */
async function buildNavTree(
  page: Page,
  selectors: ScraperSelectors,
): Promise<NavTreeNode[]> {
  // We pass the function body as a string to page.evaluate() to prevent
  // tsx/esbuild from injecting __name() decorators that don't exist in
  // the browser context.
  const tree: NavTreeNode[] = await page.evaluate(
    `(function(args) {
      var linkToNode = function(anchor) {
        var label = (anchor.textContent || '').trim();
        if (!label) return null;
        var path;
        try {
          var url = new URL(anchor.href, window.location.origin);
          path = url.pathname;
        } catch(e) {
          path = anchor.getAttribute('href') || undefined;
        }
        return { label: label, path: path, children: [] };
      };

      var walkContainer = function(container, depth) {
        var nodes = [];
        var children = Array.from(container.children);

        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          if (child.nodeType !== Node.ELEMENT_NODE) continue;

          if (child.matches('a[href]')) {
            var node = linkToNode(child);
            if (node) nodes.push(node);
            continue;
          }

          var directLink = child.querySelector(':scope > a[href]');
          if (!directLink) {
            var parts = args.sidebarItem.split(',');
            for (var pi = 0; pi < parts.length && !directLink; pi++) {
              directLink = child.querySelector(':scope > ' + parts[pi].trim());
            }
          }

          var nestedContainer =
            child.querySelector(':scope > ul') ||
            child.querySelector(':scope > ol') ||
            child.querySelector(':scope > div > ul') ||
            child.querySelector(':scope > div > ol');

          if (directLink && directLink.matches('a[href]')) {
            var node2 = linkToNode(directLink);
            if (node2) {
              if (nestedContainer) {
                node2.children = walkContainer(nestedContainer, depth + 1);
              }
              nodes.push(node2);
            }
          } else if (nestedContainer) {
            var labelEl = child.querySelector(':scope > span, :scope > div > span, :scope > p, :scope > button');
            // Also check for a plain-text div (no links) as a group header.
            // Newer GitBook themes use <div>Group Name</div> with no child elements.
            if (!labelEl) {
              var candidateDivs = child.querySelectorAll(':scope > div');
              for (var cdi = 0; cdi < candidateDivs.length; cdi++) {
                var cd = candidateDivs[cdi];
                if (!cd.querySelector('a[href]') && (cd.textContent || '').trim()) {
                  labelEl = cd;
                  break;
                }
              }
            }
            var label = labelEl ? (labelEl.textContent || '').trim() : '';
            if (label) {
              nodes.push({ label: label, children: walkContainer(nestedContainer, depth + 1) });
            } else {
              nodes.push.apply(nodes, walkContainer(nestedContainer, depth + 1));
            }
          } else {
            var tagLower = child.tagName.toLowerCase();
            if (tagLower === 'ul' || tagLower === 'ol') {
              nodes.push.apply(nodes, walkContainer(child, depth));
            } else if (child.querySelector('a[href]')) {
              nodes.push.apply(nodes, walkContainer(child, depth));
            }
          }
        }
        return nodes;
      };

      var nav = document.querySelector(args.sidebarNav);

      // Fallback: find the best aside sidebar container (newer GitBook themes).
      // The sidebar lives in <aside class="side-sheet"> but the actual nav
      // list is buried inside nested divs.  Find the aside with the most
      // links, then target the <ul> inside it that has the most links.
      if (!nav) {
        var asides = document.querySelectorAll('aside');
        var bestAside = null;
        var bestAsideLinks = 0;
        for (var ai = 0; ai < asides.length; ai++) {
          var count = asides[ai].querySelectorAll('a[href]').length;
          if (count > bestAsideLinks) {
            bestAsideLinks = count;
            bestAside = asides[ai];
          }
        }
        if (bestAside && bestAsideLinks >= 2) {
          // Find the <ul> or <ol> inside the aside with the most links.
          var lists = bestAside.querySelectorAll('ul, ol');
          var bestList = null;
          var bestListLinks = 0;
          for (var li = 0; li < lists.length; li++) {
            var listLinkCount = lists[li].querySelectorAll('a[href]').length;
            if (listLinkCount > bestListLinks) {
              bestListLinks = listLinkCount;
              bestList = lists[li];
            }
          }
          nav = bestList || bestAside;
        }
      }

      if (!nav) return [];
      return walkContainer(nav, 0);
    })(${JSON.stringify({ sidebarNav: selectors.sidebarNav, sidebarItem: selectors.sidebarItem })})`,
  );

  return tree;
}
