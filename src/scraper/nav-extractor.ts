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

  return tree;
}

// ── Expansion logic ──────────────────────────────────────────────────

/**
 * Iteratively click collapsed sidebar toggles until no new items appear
 * or `maxRounds` is exhausted.
 */
async function expandAllCollapsed(
  page: Page,
  selectors: ScraperSelectors,
  maxRounds: number,
): Promise<void> {
  let previousItemCount = 0;

  for (let round = 0; round < maxRounds; round++) {
    // Count how many sidebar items exist right now.
    const currentItemCount = await countSidebarItems(page, selectors);

    // Find all collapsed toggles (aria-expanded="false").
    const collapsedToggles = await page.$$(
      `${selectors.sidebarNav} ${selectors.collapsibleToggle}[aria-expanded="false"]`,
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

    const newItemCount = await countSidebarItems(page, selectors);

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
  selectors: ScraperSelectors,
): Promise<number> {
  return page.$$eval(
    `${selectors.sidebarNav} a[href]`,
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
  const tree: NavTreeNode[] = await page.evaluate(
    ({ sidebarNav, sidebarItem }: { sidebarNav: string; sidebarItem: string }) => {
      // NavTreeNode type is not available in the browser context, so we
      // define the shape inline.
      type NavTreeNode = {
        label: string;
        path?: string;
        children: NavTreeNode[];
      };

      /**
       * Recursively walk a container element and extract nav nodes.
       */
      function walkContainer(container: Element, depth: number): NavTreeNode[] {
        const nodes: NavTreeNode[] = [];

        // GitBook sidebar structures vary.  We look for:
        //   1. Direct child `<a>` links (leaf pages).
        //   2. Child `<div>` / `<li>` wrappers that may contain a label
        //      + nested children (group nodes).

        const children = Array.from(container.children);

        for (const child of children) {
          // Skip non-element nodes.
          if (child.nodeType !== Node.ELEMENT_NODE) continue;

          // Case 1: The child itself is a link.
          if (child.matches('a[href]')) {
            const node = linkToNode(child as HTMLAnchorElement);
            if (node) nodes.push(node);
            continue;
          }

          // Case 2: The child contains a link at top level and possibly
          // nested children in a sub-list.
          const directLink = child.querySelector(':scope > a[href]') ??
            child.querySelector(`:scope > ${sidebarItem}`);

          // Look for nested containers (ul, ol, div with links).
          const nestedContainer =
            child.querySelector(':scope > ul') ??
            child.querySelector(':scope > ol') ??
            child.querySelector(':scope > div > ul') ??
            child.querySelector(':scope > div > ol');

          if (directLink && directLink.matches('a[href]')) {
            const node = linkToNode(directLink as HTMLAnchorElement);
            if (node) {
              if (nestedContainer) {
                node.children = walkContainer(nestedContainer, depth + 1);
              }
              nodes.push(node);
            }
          } else if (nestedContainer) {
            // This may be a group label without a link.
            const labelEl = child.querySelector(':scope > span, :scope > div > span, :scope > p, :scope > button');
            const label = labelEl ? (labelEl.textContent ?? '').trim() : '';

            if (label) {
              const groupNode: NavTreeNode = {
                label,
                children: walkContainer(nestedContainer, depth + 1),
              };
              nodes.push(groupNode);
            } else {
              // No label -- hoist the nested children.
              nodes.push(...walkContainer(nestedContainer, depth + 1));
            }
          } else {
            // Check if the child itself is a list or container with
            // deeper links.
            const tagLower = child.tagName.toLowerCase();
            if (tagLower === 'ul' || tagLower === 'ol') {
              nodes.push(...walkContainer(child, depth));
            } else if (child.querySelector('a[href]')) {
              // Recurse into a wrapper div that contains links.
              nodes.push(...walkContainer(child, depth));
            }
          }
        }

        return nodes;
      }

      /**
       * Convert an `<a>` element into a `NavTreeNode`.
       */
      function linkToNode(anchor: HTMLAnchorElement): NavTreeNode | null {
        const label = (anchor.textContent ?? '').trim();
        if (!label) return null;

        let path: string | undefined;
        try {
          const url = new URL(anchor.href, window.location.origin);
          path = url.pathname;
        } catch {
          path = anchor.getAttribute('href') ?? undefined;
        }

        return { label, path, children: [] };
      }

      // --- Entry point -----------------------------------------------
      const nav = document.querySelector(sidebarNav);
      if (!nav) return [] as NavTreeNode[];

      return walkContainer(nav, 0);
    },
    { sidebarNav: selectors.sidebarNav, sidebarItem: selectors.sidebarItem },
  );

  return tree;
}
