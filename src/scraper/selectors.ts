/**
 * Configurable DOM selectors for the Playwright scraper.
 *
 * These selectors target the standard GitBook rendered HTML structure.
 * They can be overridden via `MigrationConfig.scraper.selectors` to
 * accommodate custom GitBook themes or non-standard layouts.
 */

// ── Default selector map ─────────────────────────────────────────────

export const defaultSelectors = {
  /** Sidebar navigation containing the page tree. */
  sidebarNav: 'nav[aria-label="Table of contents"]',

  /** Top-level sections/tabs navigation (multi-section sites). */
  sectionsNav: 'nav#sections',

  /** Main content area of each page. */
  mainContent: 'main',

  /** Root element used for extracting CSS custom properties / theme. */
  themeContainer: 'html',

  /** Individual sidebar links (page links, generic anchors). */
  sidebarItem: '[data-testid="page-link"], a[href]',

  /** Buttons that expand/collapse sidebar groups. */
  collapsibleToggle: 'button[aria-expanded]',

  /** Copy-to-clipboard buttons on code blocks (removed during cleanup). */
  copyButton: 'button[aria-label="Copy"]',

  /** Breadcrumb navigation (removed during cleanup). */
  breadcrumbs: 'nav[aria-label="Breadcrumbs"]',

  /** "Last modified" / "Updated X ago" metadata (removed during cleanup). */
  lastModified: '[data-testid="last-modified"]',

  /** On-page table of contents sidebar (removed during cleanup). */
  toc: 'nav[aria-label="On this page"]',
};

// ── Derived type ─────────────────────────────────────────────────────

export type ScraperSelectors = {
  sidebarNav: string;
  sectionsNav: string;
  mainContent: string;
  themeContainer: string;
  sidebarItem: string;
  collapsibleToggle: string;
  copyButton: string;
  breadcrumbs: string;
  lastModified: string;
  toc: string;
};

// ── Merge helper ─────────────────────────────────────────────────────

/**
 * Merge a partial set of custom selectors with the defaults.
 * Any key present in `custom` overrides the corresponding default.
 */
export function mergeSelectors(custom: Partial<ScraperSelectors>): ScraperSelectors {
  return { ...defaultSelectors, ...custom } as ScraperSelectors;
}
