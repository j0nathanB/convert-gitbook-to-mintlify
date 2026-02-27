/**
 * Extract top-level tabs (sections) from a GitBook site.
 *
 * GitBook multi-section sites render a `<nav id="sections">` element
 * containing links to each top-level tab.  This module reads that DOM
 * structure and returns an array of { label, url } pairs.
 */

import type { ScraperSelectors } from './selectors.js';

// Use `import type` for Playwright types -- the actual import is dynamic.
import type { Page } from 'playwright';

// ── Public API ───────────────────────────────────────────────────────

/**
 * Extract tab names and URLs from the sections navigation element.
 *
 * @param page - A Playwright `Page` instance (typed as `any` so callers
 *   do not need Playwright installed at compile time).
 * @param selectors - The active selector configuration.
 * @returns An array of `{ label, url }` for each discovered tab, in DOM
 *   order.  Returns an empty array if the sections nav is not found.
 */
export async function extractTabs(
  page: any,
  selectors: ScraperSelectors,
): Promise<Array<{ label: string; url: string }>> {
  const p = page as Page;

  const sectionsNav = await p.$(selectors.sectionsNav);
  if (!sectionsNav) {
    return [];
  }

  const links = await sectionsNav.$$('a[href]');

  const tabs: Array<{ label: string; url: string }> = [];

  for (const link of links) {
    const label = ((await link.textContent()) ?? '').trim();
    const href = (await link.getAttribute('href')) ?? '';

    if (label && href) {
      // Resolve relative URLs against the page origin.
      const resolvedUrl = new URL(href, p.url()).href;
      tabs.push({ label, url: resolvedUrl });
    }
  }

  return tabs;
}
