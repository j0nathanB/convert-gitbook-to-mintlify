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
import { extractNavigation } from './nav-extractor.js';
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
}

export interface CrawlResult {
  pages: CrawledPage[];
  errors: string[];
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
    const pageUrls = deduplicateUrls(
      flattenNavUrls(navTree, origin),
      origin,
      options.skipPaths,
    );

    // Always include the root URL itself.
    const rootNormalized = normalizeUrl(url);
    if (!pageUrls.some((u) => normalizeUrl(u) === rootNormalized)) {
      pageUrls.unshift(url);
    }

    logger.info(`Discovered ${pageUrls.length} page(s) to crawl.`);

    // We are done with the root page.
    await rootPage.close();

    // --- Fetch pages concurrently in batches ---------------------------
    const pages: CrawledPage[] = [];
    const concurrency = Math.max(1, options.concurrency);

    for (let i = 0; i < pageUrls.length; i += concurrency) {
      const batch = pageUrls.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map((pageUrl) => fetchPage(context, pageUrl, options)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          pages.push(result.value);
        } else if (result.status === 'rejected') {
          const msg = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
          errors.push(msg);
          logger.warn(`Failed to fetch page: ${msg}`);
        }
      }

      // Delay between batches.
      if (options.delayMs > 0 && i + concurrency < pageUrls.length) {
        await delay(options.delayMs);
      }
    }

    logger.success(
      `Crawl complete: ${pages.length} page(s) fetched, ${errors.length} error(s).`,
    );

    return { pages, errors };
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

    return { url, path, html, title };
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
 * Deduplicate URLs (by pathname) and remove any that match `skipPaths`.
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

    const pathname = new URL(u).pathname;
    const shouldSkip = skipPaths.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
    );

    if (shouldSkip) continue;

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
 * Simple async delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
