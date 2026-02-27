/**
 * Playwright-based site crawler for GitBook documentation.
 *
 * Launches a headless browser, discovers all pages from the sidebar
 * navigation, and fetches each page's rendered HTML.  Designed to work
 * even when the GitBook API is unavailable (e.g., for published-only
 * sites).
 *
 * Playwright is an **optional** dependency.  If it is not installed the
 * dynamic `import('playwright')` will throw and the caller should fall
 * back to a different data source.
 */

import type { ScraperSelectors } from './selectors.js';
import type { NavTreeNode } from '../types.js';
import { extractNavigation } from './nav-extractor.js';
import { extractTabs } from './tab-extractor.js';
import { logger } from '../utils/logger.js';

// Compile-time only -- never a hard require.
import type { Browser, BrowserContext, Page } from 'playwright';

// ── Public types ─────────────────────────────────────────────────────

export interface CrawlerOptions {
  /** Maximum number of pages to fetch in parallel.  Default: 16. */
  concurrency: number;
  /** Delay (ms) inserted between page loads to avoid rate-limiting. */
  delayMs: number;
  /** Number of sidebar expansion rounds (see nav-extractor). */
  sidebarExpansionRounds: number;
  /** Path prefixes to skip (e.g. `["/api-ref"]`). */
  skipPaths: string[];
  /** Optional cookie value for authenticated sites. */
  authCookie?: string;
  /** DOM selector overrides. */
  selectors: ScraperSelectors;
}

export interface CrawledPage {
  /** Fully-qualified URL that was fetched. */
  url: string;
  /** Pathname extracted from the URL (e.g. `/guides/getting-started`). */
  path: string;
  /** Full outer HTML of the page after rendering. */
  html: string;
  /** Page title extracted from the DOM. */
  title: string;
  /** Layout hints detected from the page's DOM structure. */
  layoutHints?: {
    /** Whether the page has a table of contents (right sidebar). */
    hasToc: boolean;
    /** Whether the page uses wide content width. */
    isWide: boolean;
    /** Whether the main content is visually centered. */
    isCentered: boolean;
  };
}

export interface CrawledTab {
  /** Display label for the tab (e.g. "Documentation", "API Reference"). */
  label: string;
  /** Fully-qualified URL for the tab's landing page. */
  url: string;
  /** URL-derived slug (e.g. "documentation", "api-reference"). */
  slug: string;
  /** Sidebar navigation tree extracted from this tab's page. */
  navTree: NavTreeNode[];
}

export interface CrawlResult {
  pages: CrawledPage[];
  errors: string[];
  /** Tab structure discovered from the sections nav. Empty if no tabs found. */
  tabs: CrawledTab[];
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Crawl an entire GitBook site starting from `url`.
 *
 * 1. Launch a headless Chromium browser (via dynamic import).
 * 2. Navigate to the root URL and expand the sidebar.
 * 3. Discover all page URLs from sidebar links.
 * 4. Fetch each page concurrently in batches.
 * 5. Return the collected HTML and any per-page errors.
 *
 * @throws If Playwright is not installed.
 */
export async function crawlSite(
  url: string,
  options: CrawlerOptions,
): Promise<CrawlResult> {
  // --- Dynamic import of playwright ----------------------------------
  const { chromium } = await import('playwright');

  const errors: string[] = [];

  let browser: Browser | undefined;

  try {
    // --- Launch browser ------------------------------------------------
    browser = await chromium.launch({ headless: true });
    const context = await createContext(browser, url, options.authCookie);
    const rootPage = await context.newPage();

    // --- Navigate to root URL ------------------------------------------
    logger.info(`Navigating to ${url}`);
    await rootPage.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

    // --- Discover pages from sidebar -----------------------------------
    logger.info('Expanding sidebar and discovering pages...');
    const navTree = await extractNavigation(
      rootPage,
      options.selectors,
      options.sidebarExpansionRounds,
    );

    // Flatten the nav tree into a deduplicated list of absolute URLs.
    const origin = new URL(url).origin;
    const allDiscoveredUrls: string[] = flattenNavUrls(navTree, origin);

    // --- Also discover pages from tabs (sections) ----------------------
    // GitBook sites with multiple tabs render each tab's pages in a
    // separate sidebar. Visit each tab URL and extract its sidebar nav.
    logger.info('Checking for tab sections...');
    const rawTabs = await extractTabs(rootPage, options.selectors);
    const crawledTabs: CrawledTab[] = [];

    if (rawTabs.length > 0) {
      logger.info(`Found ${rawTabs.length} tab(s): ${rawTabs.map((t) => t.label).join(', ')}`);
      for (const tab of rawTabs) {
        allDiscoveredUrls.push(tab.url);
        let tabNavTree: NavTreeNode[] = [];
        try {
          const tabPage = await context.newPage();
          await tabPage.goto(tab.url, { waitUntil: 'networkidle', timeout: 30_000 });
          tabNavTree = await extractNavigation(
            tabPage,
            options.selectors,
            options.sidebarExpansionRounds,
          );
          allDiscoveredUrls.push(...flattenNavUrls(tabNavTree, origin));
          await tabPage.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to extract nav from tab "${tab.label}": ${msg}`);
          errors.push(`Tab "${tab.label}" nav extraction failed: ${msg}`);
        }

        crawledTabs.push({
          label: tab.label,
          url: tab.url,
          slug: deriveSlug(tab.url, origin),
          navTree: tabNavTree,
        });
      }
    }

    // --- Also discover pages from internal links in page body ----------
    // GitBook sites may embed navigation in the page content itself
    // (hero cards, feature links, etc.) rather than in a sidebar.
    const bodyLinks = await rootPage.$$eval(
      'a[href]',
      (anchors: HTMLAnchorElement[], baseOrigin: string) => {
        return anchors
          .map((a) => {
            try { return new URL(a.href, baseOrigin).href; } catch { return ''; }
          })
          .filter((href) => href.startsWith(baseOrigin));
      },
      origin,
    );
    allDiscoveredUrls.push(...bodyLinks);

    const pageUrls = deduplicateUrls(allDiscoveredUrls, origin, options.skipPaths);

    // Always include the root URL itself.
    const rootNormalized = normalizeUrl(url);
    if (!pageUrls.some((u) => normalizeUrl(u) === rootNormalized)) {
      pageUrls.unshift(url);
    }

    logger.info(`Discovered ${pageUrls.length} page(s) to crawl.`);

    // We are done with the root page.
    await rootPage.close();

    // --- Fetch pages concurrently in batches ---------------------------
    // Use a queue so newly discovered links can be added during crawling.
    const pages: CrawledPage[] = [];
    const concurrency = Math.max(1, options.concurrency);
    const visited = new Set(pageUrls.map(normalizeUrl));
    const queue = [...pageUrls];

    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);

      const results = await Promise.allSettled(
        batch.map((pageUrl) => fetchPage(context, pageUrl, options)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          pages.push(result.value);

          // Discover new internal links from each fetched page.
          const newLinks = extractInternalLinks(result.value.html, origin);
          for (const link of newLinks) {
            const norm = normalizeUrl(link);
            let pathname: string;
            try {
              pathname = new URL(link).pathname;
            } catch { continue; }

            // Skip .md links, non-content patterns, and user-defined skip paths.
            if (pathname.endsWith('.md')) continue;
            if (SKIP_PATH_PATTERNS.some((re) => re.test(pathname))) continue;
            const shouldSkip = options.skipPaths.some(
              (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
            );
            if (!visited.has(norm) && !shouldSkip) {
              visited.add(norm);
              queue.push(link);
            }
          }
        } else if (result.status === 'rejected') {
          const msg = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
          errors.push(msg);
          logger.warn(`Failed to fetch page: ${msg}`);
        }
      }

      // Delay between batches.
      if (options.delayMs > 0 && queue.length > 0) {
        await delay(options.delayMs);
      }
    }

    logger.success(
      `Crawl complete: ${pages.length} page(s) fetched, ${errors.length} error(s).`,
    );

    return { pages, errors, tabs: crawledTabs };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Create a browser context, optionally injecting an auth cookie.
 */
async function createContext(
  browser: Browser,
  url: string,
  authCookie?: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (compatible; gitbook-to-mintlify/1.0; +https://github.com/gitbook-to-mintlify)',
  });

  if (authCookie) {
    const parsed = new URL(url);
    await context.addCookies([
      {
        name: 'gitbook-auth',
        value: authCookie,
        domain: parsed.hostname,
        path: '/',
      },
    ]);
  }

  return context;
}

/**
 * Fetch a single page: navigate, wait for content, extract HTML + title.
 */
async function fetchPage(
  context: BrowserContext,
  url: string,
  options: CrawlerOptions,
): Promise<CrawledPage> {
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

    // Wait a moment for client-side hydration.
    await page.waitForTimeout(300);

    const title = await page.title();
    const html = await page.content();
    const path = new URL(url).pathname;

    // Detect layout hints from <main> element classes.
    const layoutHints = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return undefined;
      const classes = main.className || '';
      const hasToc = classes.includes('page-has-toc');
      const isWide = classes.includes('page-width-wide');
      // Check if content is centered: left and right margins roughly equal.
      const rect = main.getBoundingClientRect();
      const vw = window.innerWidth;
      const left = rect.left;
      const right = vw - rect.right;
      const isCentered = Math.abs(left - right) < 50 && left > 100;
      return { hasToc, isWide, isCentered };
    });

    return { url, path, html, title, layoutHints: layoutHints ?? undefined };
  } finally {
    await page.close();
  }
}

/**
 * Recursively flatten a `NavTreeNode[]` into a list of absolute URLs.
 */
function flattenNavUrls(
  nodes: Array<{ label: string; path?: string; children: any[] }>,
  origin: string,
): string[] {
  const urls: string[] = [];

  for (const node of nodes) {
    if (node.path) {
      try {
        const absolute = new URL(node.path, origin).href;
        urls.push(absolute);
      } catch {
        // Skip malformed paths.
      }
    }
    if (node.children?.length) {
      urls.push(...flattenNavUrls(node.children, origin));
    }
  }

  return urls;
}

/**
 * URL path patterns that are never real documentation pages.
 * These are GitBook internal resources, feeds, and metadata.
 */
const SKIP_PATH_PATTERNS = [
  /\/~gitbook\//,       // GitBook internal resources (icons, images, etc.)
  /\/rss\.xml$/,        // RSS feeds
  /\/readme\.md$/i,     // readme.md redirects
  /\/sitemap\.xml$/,    // Sitemaps
  /\/robots\.txt$/,     // Robots
];

/**
 * Deduplicate URLs (by pathname) and remove any that match `skipPaths`
 * or known non-content patterns.
 */
function deduplicateUrls(
  urls: string[],
  origin: string,
  skipPaths: string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const u of urls) {
    const normalized = normalizeUrl(u);

    if (seen.has(normalized)) continue;

    let pathname: string;
    try {
      const parsed = new URL(u);
      pathname = parsed.pathname;
      // Skip URLs with query parameters (likely GitBook API/resource URLs).
      if (parsed.search) continue;
    } catch {
      continue;
    }

    const shouldSkip = skipPaths.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
    );
    if (shouldSkip) continue;

    // Skip known non-content patterns.
    if (SKIP_PATH_PATTERNS.some((re) => re.test(pathname))) continue;

    // Skip .md URLs entirely — GitBook redirects them to the clean path,
    // which we'll crawl separately.
    if (pathname.endsWith('.md')) continue;

    seen.add(normalized);
    result.push(u);
  }

  return result;
}

/**
 * Normalize a URL for deduplication: strip trailing slash and hash.
 */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

/**
 * Extract internal links from an HTML string.
 * Returns absolute URLs that belong to the same origin, excluding
 * known non-content patterns.
 */
function extractInternalLinks(html: string, origin: string): string[] {
  const urls: string[] = [];
  const hrefRe = /href="([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = hrefRe.exec(html)) !== null) {
    try {
      const parsed = new URL(match[1], origin);
      const abs = parsed.href;
      if (
        abs.startsWith(origin) &&
        !parsed.hash &&
        !parsed.search &&
        !SKIP_PATH_PATTERNS.some((re) => re.test(parsed.pathname))
      ) {
        urls.push(abs);
      }
    } catch {
      // Skip malformed URLs.
    }
  }

  return urls;
}

/**
 * Derive a URL slug from a tab URL by taking the last non-empty path
 * segment relative to the origin.
 *
 * E.g. `https://example.gitbook.io/my-docs/documentation` → `documentation`
 *      `https://example.gitbook.io/my-docs` → `my-docs`
 */
function deriveSlug(tabUrl: string, origin: string): string {
  try {
    const pathname = new URL(tabUrl).pathname.replace(/\/+$/, '');
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Simple async delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
