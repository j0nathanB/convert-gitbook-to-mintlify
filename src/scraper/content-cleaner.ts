/**
 * HAST-level cleanup for scraped GitBook HTML.
 *
 * When content is obtained via the Playwright scraper rather than the
 * API, it contains UI chrome (copy buttons, breadcrumbs, TOC sidebar,
 * metadata badges) that must be stripped before conversion to MDX.
 *
 * This module parses raw HTML into a HAST tree, removes unwanted nodes
 * by matching against the configured selectors, and serializes the
 * cleaned tree back to an HTML string.
 */

import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import type { Root, Element, RootContent } from 'hast';
import type { ScraperSelectors } from './selectors.js';

// ── Public API ───────────────────────────────────────────────────────

/**
 * Parse `html` into a HAST tree, remove GitBook UI artifacts, and
 * serialize back to a clean HTML string.
 *
 * Removed elements:
 *   - Copy buttons on code blocks (`button[aria-label="Copy"]`)
 *   - Breadcrumb navigation (`nav[aria-label="Breadcrumbs"]`)
 *   - "Updated X ago" metadata (`[data-testid="last-modified"]`)
 *   - On-page table of contents (`nav[aria-label="On this page"]`)
 *
 * @param html - The raw full-page HTML string.
 * @param selectors - Active selector configuration.
 * @returns Cleaned HTML string.
 */
export function cleanScrapedContent(
  html: string,
  selectors: ScraperSelectors,
): string {
  const tree = parseHtml(html);

  // Build the list of CSS selectors to remove.
  const removeSelectors = [
    selectors.copyButton,
    selectors.breadcrumbs,
    selectors.lastModified,
    selectors.toc,
    // GitBook "Ask AI" assistant button.
    'button[aria-label="GitBook Assistant"]',
    // "More" dropdown button next to the Ask button.
    'button[aria-label="More"]',
  ];

  removeMatchingNodes(tree, removeSelectors);

  return serializeHast(tree);
}

/**
 * Extract only the main content area from a full-page HTML string.
 *
 * First runs `cleanScrapedContent` to strip UI artifacts, then
 * extracts the subtree rooted at the `mainContent` selector.
 *
 * @param html - The raw full-page HTML string.
 * @param selectors - Active selector configuration.
 * @returns HTML string of just the main content, or the full cleaned
 *   HTML if the main content element is not found.
 */
export function extractMainContent(
  html: string,
  selectors: ScraperSelectors,
): string {
  const tree = parseHtml(html);

  // Strip artifacts first.
  const removeSelectors = [
    selectors.copyButton,
    selectors.breadcrumbs,
    selectors.lastModified,
    selectors.toc,
    // GitBook "Ask AI" assistant button.
    'button[aria-label="GitBook Assistant"]',
    // "More" dropdown button next to the Ask button.
    'button[aria-label="More"]',
  ];
  removeMatchingNodes(tree, removeSelectors);

  // Find the main content node.
  const mainNode = findMatchingNode(tree, selectors.mainContent);

  let cleaned: string;
  if (mainNode) {
    // Wrap in a synthetic root so serialization works.
    const syntheticRoot: Root = {
      type: 'root',
      children: [mainNode],
    };
    cleaned = serializeHast(syntheticRoot);
  } else {
    // Fallback: return the entire cleaned document.
    cleaned = serializeHast(tree);
  }

  // Post-process: strip common GitBook text artifacts that survive HAST cleanup.
  cleaned = stripTextArtifacts(cleaned);

  // Strip prev/next navigation containers that GitBook renders at the
  // end of content.  These contain <a> elements with "Previous"/"Next"
  // text that pollute the MDX output.
  cleaned = stripPrevNextNav(cleaned);

  return cleaned;
}

// ── Text-level artifact stripping ─────────────────────────────────────

/**
 * Remove common GitBook UI text artifacts that survive HAST element removal.
 * These include standalone "Copy" text from code block buttons and
 * "Last updated/modified" timestamps.
 */
function stripTextArtifacts(html: string): string {
  // Remove "Copy" button text that appears as standalone text near code blocks.
  // It typically appears right before <pre> or as a standalone line.
  html = html.replace(/<button[^>]*>Copy<\/button>/gi, '');

  // Remove "Last updated X ago" or "Last modified on ..." lines.
  html = html.replace(
    /<[^>]*>Last (updated|modified)\b[^<]*<\/[^>]*>/gi,
    '',
  );

  return html;
}

/**
 * Strip prev/next navigation blocks from the end of content.
 *
 * GitBook renders navigation containers at the bottom of pages with
 * "Previous" and "Next" links.  These appear as containers with child
 * `<a>` elements containing spans with "Previous"/"Next" text.
 */
function stripPrevNextNav(html: string): string {
  // Remove containers with Previous/Next navigation links.
  // Pattern: a block containing <a> with "Previous" or "Next" span text.
  html = html.replace(
    /<(?:div|nav|footer)[^>]*>(?:[^]*?)<span[^>]*>(?:Previous|Next)<\/span>(?:[^]*?)<\/(?:div|nav|footer)>/gi,
    '',
  );

  return html;
}

// ── HAST parsing & serialization ─────────────────────────────────────

/**
 * Parse an HTML string into a HAST `Root` node.
 */
function parseHtml(html: string): Root {
  const processor = unified().use(rehypeParse);
  return processor.parse(html) as Root;
}

/**
 * Serialize a HAST tree back to an HTML string.
 *
 * We use a simple recursive serializer rather than pulling in
 * rehype-stringify to keep dependencies minimal (rehype-parse is
 * already required).
 */
function serializeHast(node: Root | Element): string {
  return serializeChildren(node);
}

function serializeNode(node: RootContent | Root): string {
  switch (node.type) {
    case 'root':
      return serializeChildren(node as Root);

    case 'element': {
      const el = node as Element;
      const tag = el.tagName;
      const attrs = serializeAttributes(el.properties ?? {});
      const attrStr = attrs ? ` ${attrs}` : '';

      // Void elements (self-closing).
      if (VOID_ELEMENTS.has(tag)) {
        return `<${tag}${attrStr}>`;
      }

      const inner = serializeChildren(el);
      return `<${tag}${attrStr}>${inner}</${tag}>`;
    }

    case 'text':
      return (node as any).value ?? '';

    case 'comment':
      return `<!--${(node as any).value ?? ''}-->`;

    case 'doctype':
      return '<!DOCTYPE html>';

    default:
      return '';
  }
}

function serializeChildren(node: { children?: Array<RootContent | Root> }): string {
  if (!node.children) return '';
  return node.children.map(serializeNode).join('');
}

function serializeAttributes(properties: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === false || value === null || value === undefined) continue;

    // Convert HAST property names back to HTML attribute names.
    const attrName = hastPropToAttr(key);

    if (value === true) {
      parts.push(attrName);
    } else if (Array.isArray(value)) {
      parts.push(`${attrName}="${escapeAttr(value.join(' '))}"`);
    } else {
      parts.push(`${attrName}="${escapeAttr(String(value))}"`);
    }
  }
  return parts.join(' ');
}

/**
 * Convert a HAST camelCase property name to its HTML attribute equivalent.
 */
function hastPropToAttr(prop: string): string {
  // Special cases.
  const special: Record<string, string> = {
    className: 'class',
    htmlFor: 'for',
    httpEquiv: 'http-equiv',
    acceptCharset: 'accept-charset',
  };
  if (special[prop]) return special[prop];

  // data-* and aria-* are already lowercase with hyphens in HAST.
  if (prop.startsWith('data') || prop.startsWith('aria')) {
    // Convert camelCase to kebab-case: dataTestid -> data-testid.
    return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
  }

  return prop.toLowerCase();
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// ── HAST tree manipulation ───────────────────────────────────────────

/**
 * Remove all nodes from the tree that match any of the given CSS
 * selectors.  Uses a simplified CSS selector matcher that covers the
 * selectors used by `defaultSelectors`.
 */
function removeMatchingNodes(tree: Root, selectors: string[]): void {
  const matchers = selectors.map(parseCssSelector);

  function walk(node: Root | Element): void {
    if (!node.children) return;

    // Filter out matching children, then recurse into survivors.
    node.children = node.children.filter((child) => {
      if (child.type !== 'element') return true;
      const el = child as Element;
      return !matchers.some((matcher) => matcher(el));
    });

    for (const child of node.children) {
      if (child.type === 'element' || (child as any).type === 'root') {
        walk(child as Element);
      }
    }
  }

  walk(tree);
}

/**
 * Find the first node in the tree matching a CSS selector.
 */
function findMatchingNode(tree: Root, selector: string): Element | undefined {
  const matcher = parseCssSelector(selector);

  function walk(node: Root | Element): Element | undefined {
    if (!node.children) return undefined;

    for (const child of node.children) {
      if (child.type !== 'element') continue;
      const el = child as Element;
      if (matcher(el)) return el;

      const found = walk(el);
      if (found) return found;
    }

    return undefined;
  }

  return walk(tree);
}

// ── Simplified CSS selector parser ───────────────────────────────────

type ElementMatcher = (el: Element) => boolean;

/**
 * Parse a simplified CSS selector into a matcher function.
 *
 * Supports:
 *   - Tag name: `main`, `nav`
 *   - ID: `#sections`, `nav#sections`
 *   - Attribute: `[aria-label="Copy"]`, `[data-testid="last-modified"]`
 *   - Comma-separated alternatives: `[data-testid="page-link"], a[href]`
 *
 * This is intentionally not a full CSS selector engine -- it only needs
 * to handle the patterns used in `defaultSelectors`.
 */
function parseCssSelector(selector: string): ElementMatcher {
  // Handle comma-separated selectors.
  if (selector.includes(',')) {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    const matchers = parts.map(parseSingleSelector);
    return (el) => matchers.some((m) => m(el));
  }

  return parseSingleSelector(selector);
}

function parseSingleSelector(selector: string): ElementMatcher {
  const checks: Array<(el: Element) => boolean> = [];

  let remaining = selector.trim();

  // Tag name (leading word characters).
  const tagMatch = remaining.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tagMatch) {
    const tag = tagMatch[1].toLowerCase();
    checks.push((el) => el.tagName.toLowerCase() === tag);
    remaining = remaining.slice(tagMatch[0].length);
  }

  // ID: #value
  const idMatch = remaining.match(/^#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    const id = idMatch[1];
    checks.push((el) => {
      const props = el.properties ?? {};
      return props.id === id;
    });
    remaining = remaining.slice(idMatch[0].length);
  }

  // Attribute selectors: [attr], [attr="value"]
  const attrRe = /\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(remaining)) !== null) {
    const attrName = attrMatch[1];
    const attrValue = attrMatch[2]; // undefined for bare [attr]

    // HAST stores attributes in `properties` with camelCase keys for
    // standard HTML attributes and the original name for data-*/aria-*.
    checks.push((el) => {
      const props = el.properties ?? {};

      // Try the attribute name as-is.
      if (attrName in props) {
        if (attrValue === undefined) return true;
        return String(props[attrName]) === attrValue;
      }

      // Try camelCase conversion: aria-label -> ariaLabel.
      const camel = attrName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (camel in props) {
        if (attrValue === undefined) return true;
        return String(props[camel]) === attrValue;
      }

      return false;
    });
  }

  if (checks.length === 0) {
    // If we parsed nothing, return a never-matching function.
    return () => false;
  }

  return (el) => checks.every((check) => check(el));
}
