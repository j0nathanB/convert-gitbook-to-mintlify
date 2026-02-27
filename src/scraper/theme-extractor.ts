/**
 * Extract branding / theme information from a live GitBook page.
 *
 * Reads CSS custom properties, header logos, and favicon links from
 * the DOM and returns a structured `ThemeResult` with confidence
 * scores for each extracted value.
 */

import type { ScraperSelectors } from './selectors.js';

// Compile-time only -- Playwright is dynamically imported at runtime.
import type { Page } from 'playwright';

// ── Public types ─────────────────────────────────────────────────────

export interface ThemeValue<T = string> {
  value: T;
  confidence: 'high' | 'medium' | 'low';
}

export interface ThemeResult {
  primaryColor?: ThemeValue;
  font?: ThemeValue;
  logo?: {
    light?: string;
    dark?: string;
    confidence: 'high' | 'medium' | 'low';
  };
  favicon?: ThemeValue;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Extract theme/branding information from the currently loaded page.
 *
 * @param page - A Playwright `Page` instance (typed as `any` for optional-dep safety).
 * @param selectors - The active selector configuration.
 * @returns A `ThemeResult` containing whatever branding data could be extracted.
 */
export async function extractTheme(
  page: any,
  selectors: ScraperSelectors,
): Promise<ThemeResult> {
  const p = page as Page;
  const result: ThemeResult = {};

  // --- Primary color from CSS custom properties ----------------------
  const primaryColor = await extractCssProperty(p, selectors.themeContainer, [
    '--primary-color',
    '--gb-primary-color',
    '--primary',
    '--color-primary',
    '--color-primary-500',
  ]);
  if (primaryColor) {
    result.primaryColor = primaryColor;
  }

  // --- Font family ---------------------------------------------------
  const font = await extractFont(p, selectors.themeContainer);
  if (font) {
    result.font = font;
  }

  // --- Logo images from header ---------------------------------------
  const logo = await extractLogo(p);
  if (logo) {
    result.logo = logo;
  }

  // --- Favicon -------------------------------------------------------
  const favicon = await extractFavicon(p);
  if (favicon) {
    result.favicon = favicon;
  }

  return result;
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Try a list of CSS custom property names against the given container
 * element and return the first non-empty value found.
 */
async function extractCssProperty(
  page: Page,
  containerSelector: string,
  propertyNames: string[],
): Promise<ThemeValue | undefined> {
  const value = await page.evaluate(
    ({ selector, props }: { selector: string; props: string[] }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const computed = getComputedStyle(el);
      for (const prop of props) {
        const val = computed.getPropertyValue(prop).trim();
        if (val) return { value: val, propName: prop };
      }
      return null;
    },
    { selector: containerSelector, props: propertyNames },
  );

  if (!value) return undefined;

  // Confidence heuristic: well-known GitBook property names get "high",
  // generic names get "medium".
  const confidence = value.propName.includes('gb-') || value.propName.includes('primary-color')
    ? 'high'
    : 'medium';

  return { value: value.value, confidence };
}

/**
 * Extract the primary font family from computed styles.
 */
async function extractFont(
  page: Page,
  containerSelector: string,
): Promise<ThemeValue | undefined> {
  const fontInfo = await page.evaluate(
    ({ selector }: { selector: string }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const computed = getComputedStyle(el);

      // Try CSS custom properties first (higher confidence).
      const customProps = ['--font-family', '--gb-font-family', '--font-body', '--body-font'];
      for (const prop of customProps) {
        const val = computed.getPropertyValue(prop).trim();
        if (val) return { value: val, source: 'custom-property' as const };
      }

      // Fall back to computed font-family on body.
      const body = document.querySelector('body');
      if (body) {
        const bodyFont = getComputedStyle(body).fontFamily;
        if (bodyFont) return { value: bodyFont, source: 'computed' as const };
      }

      return null;
    },
    { selector: containerSelector },
  );

  if (!fontInfo) return undefined;

  // Clean up the font value: take the first family, strip quotes.
  const rawFont = fontInfo.value;
  const firstFamily = rawFont.split(',')[0].trim().replace(/^["']|["']$/g, '');

  // System/generic fonts are low-value.
  const genericFonts = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
    '-apple-system', 'BlinkMacSystemFont', 'Segoe UI',
  ]);

  if (genericFonts.has(firstFamily)) return undefined;

  const confidence = fontInfo.source === 'custom-property' ? 'high' : 'low';

  return { value: firstFamily, confidence };
}

/**
 * Extract logo images from the page header.
 *
 * GitBook sites typically place logos in a `<header>` element,
 * sometimes with separate light/dark variants using `<picture>` or
 * data attributes.
 */
async function extractLogo(
  page: Page,
): Promise<ThemeResult['logo'] | undefined> {
  const logos = await page.evaluate(() => {
    // Strategy 1: look for images inside a header or top-bar element.
    const headerSelectors = [
      'header img[src]',
      'header svg',
      '[data-testid="site-header"] img[src]',
      '[data-testid="header-logo"] img[src]',
      'a[aria-label="Home"] img[src]',
    ];

    let lightSrc: string | undefined;
    let darkSrc: string | undefined;

    for (const sel of headerSelectors) {
      const imgs = document.querySelectorAll(sel);
      if (imgs.length === 0) continue;

      for (const img of imgs) {
        const src = img.getAttribute('src');
        if (!src) continue;

        // Check for explicit theme variants via parent <picture> or data attrs.
        const parent = img.closest('picture');
        if (parent) {
          const sources = parent.querySelectorAll('source');
          for (const source of sources) {
            const media = source.getAttribute('media') ?? '';
            const srcset = source.getAttribute('srcset') ?? '';
            if (media.includes('prefers-color-scheme: dark') && srcset) {
              darkSrc = srcset.split(',')[0].trim().split(/\s/)[0];
            } else if (srcset) {
              lightSrc = srcset.split(',')[0].trim().split(/\s/)[0];
            }
          }
        }

        // Fallback: use the img src directly.
        if (!lightSrc) {
          lightSrc = src;
        }
      }

      if (lightSrc) break;
    }

    if (!lightSrc && !darkSrc) return null;
    return { light: lightSrc, dark: darkSrc };
  });

  if (!logos) return undefined;

  return {
    light: logos.light,
    dark: logos.dark,
    confidence: logos.dark ? 'high' : 'medium',
  };
}

/**
 * Extract the favicon URL from `<link rel="icon">` or similar tags.
 */
async function extractFavicon(
  page: Page,
): Promise<ThemeValue | undefined> {
  const favicon = await page.evaluate(() => {
    const selectors = [
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
    ];

    for (const sel of selectors) {
      const link = document.querySelector(sel);
      if (link) {
        const href = link.getAttribute('href');
        if (href) return { value: href, selector: sel };
      }
    }

    return null;
  });

  if (!favicon) return undefined;

  const confidence = favicon.selector === 'link[rel="icon"]' ? 'high' : 'medium';

  // Resolve relative URLs to absolute.
  let resolvedUrl = favicon.value;
  try {
    resolvedUrl = new URL(favicon.value, page.url()).href;
  } catch {
    // Keep as-is if URL parsing fails.
  }

  return { value: resolvedUrl, confidence };
}
