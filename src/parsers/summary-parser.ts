import { readFile } from 'node:fs/promises';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, List, ListItem, Heading, Paragraph, Link, Text, Html } from 'mdast';
import type { NavTab, NavGroup, NavPage } from '../types.js';
import { logger } from '../utils/logger.js';

// ─── AST Helpers ───

/**
 * Extract the link target and label from a ListItem's first paragraph.
 * SUMMARY.md list items are expected to look like:
 *   `* [Label](path.md)`
 *
 * Returns `undefined` if the item has no link.
 */
function extractLinkFromItem(item: ListItem): { label: string; path: string } | undefined {
  // The first child of a ListItem is typically a Paragraph containing a Link.
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      for (const inline of (child as Paragraph).children) {
        if (inline.type === 'link') {
          const link = inline as Link;
          const label = extractPlainText(link as any);
          const path = link.url;
          return { label, path };
        }
      }
    }
  }
  return undefined;
}

/**
 * Recursively extract plain text from any mdast phrasing content node.
 */
function extractPlainText(node: any): string {
  if (node.type === 'text') {
    return node.value ?? '';
  }
  if (Array.isArray(node.children)) {
    return node.children.map((child: any) => extractPlainText(child)).join('');
  }
  return '';
}

/**
 * Check whether a ListItem represents a draft page.
 *
 * GitBook marks drafts by commenting them out, either with a `#` prefix or
 * an HTML comment wrapping the line.
 */
function isDraftItem(item: ListItem): boolean {
  for (const child of item.children) {
    if (child.type === 'html') {
      const html = (child as Html).value;
      if (html.includes('<!--') || html.trimStart().startsWith('#')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extract the plain-text label from a ListItem that has no link (group label).
 */
function extractPlainLabel(item: ListItem): string {
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      return extractPlainText(child);
    }
  }
  return '';
}

// ─── Tree Walking ───

/**
 * Convert a list of mdast ListItems into NavPage entries, recursively
 * building NavGroup children for nested lists.
 */
function listItemsToPages(
  items: ListItem[],
  sourceFile: string,
): { pages: NavPage[]; subgroups: NavGroup[] } {
  const pages: NavPage[] = [];
  const subgroups: NavGroup[] = [];

  for (const item of items) {
    const link = extractLinkFromItem(item);
    const draft = isDraftItem(item);

    // Check for nested list (sub-group)
    const nestedList = item.children.find(
      (child): child is List => child.type === 'list',
    );

    if (link) {
      pages.push({ label: link.label, path: link.path });

      // If this linked item also has a nested list, it forms a sub-group
      // where the link itself is the group's first page and nested items follow.
      if (nestedList) {
        const nested = listItemsToPages(nestedList.children as ListItem[], sourceFile);
        subgroups.push({
          label: link.label,
          pages: [{ label: link.label, path: link.path }, ...nested.pages],
          groups: nested.subgroups.length > 0 ? nested.subgroups : undefined,
        });
        // Remove the duplicate page we already pushed
        pages.pop();
      }
    } else if (nestedList) {
      // A non-linked item with a nested list is a group header
      const groupLabel = extractPlainLabel(item) || 'Untitled Group';
      const nested = listItemsToPages(nestedList.children as ListItem[], sourceFile);
      subgroups.push({
        label: groupLabel,
        pages: nested.pages,
        groups: nested.subgroups.length > 0 ? nested.subgroups : undefined,
      });
    }

    if (draft) {
      logger.debug(`Draft page detected in ${sourceFile}: ${link?.label ?? 'unknown'}`);
    }
  }

  return { pages, subgroups };
}

// ─── Public API ───

/**
 * Parse a SUMMARY.md string into a `NavTab` structure.
 *
 * The parser uses remark (unified + remark-parse) to build an mdast AST, then
 * walks the tree to extract headings (as group labels) and nested lists (as
 * navigation groups with pages).
 *
 * @param content    The raw markdown content of SUMMARY.md.
 * @param sourceFile Path to the source file (used for diagnostics).
 * @returns A NavTab containing the parsed navigation groups.
 */
export function parseSummary(content: string, sourceFile: string): NavTab {
  const processor = unified().use(remarkParse);
  const tree = processor.parse(content) as Root;

  const groups: NavGroup[] = [];
  let currentGroupLabel = '';
  let currentGroupPages: NavPage[] = [];
  let currentSubgroups: NavGroup[] = [];

  /**
   * Flush the accumulated pages into a NavGroup and reset state.
   */
  function flushGroup(): void {
    if (currentGroupPages.length > 0 || currentSubgroups.length > 0) {
      groups.push({
        label: currentGroupLabel || 'Overview',
        pages: currentGroupPages,
        groups: currentSubgroups.length > 0 ? currentSubgroups : undefined,
      });
    }
    currentGroupPages = [];
    currentSubgroups = [];
  }

  for (const node of tree.children) {
    switch (node.type) {
      case 'heading': {
        const heading = node as Heading;
        // ## headings in SUMMARY.md become group labels
        if (heading.depth === 2) {
          flushGroup();
          currentGroupLabel = extractPlainText(heading);
        }
        break;
      }

      case 'list': {
        const list = node as List;
        const result = listItemsToPages(list.children as ListItem[], sourceFile);
        currentGroupPages.push(...result.pages);
        currentSubgroups.push(...result.subgroups);
        break;
      }

      case 'html': {
        // HTML comments may contain draft markers
        const html = (node as Html).value;
        if (html.includes('<!--')) {
          logger.debug(`HTML comment (possible draft marker) in ${sourceFile}`);
        }
        break;
      }

      default:
        // Ignore other top-level nodes (paragraphs, thematic breaks, etc.)
        break;
    }
  }

  // Flush any remaining accumulated pages
  flushGroup();

  // Derive tab label and slug from the first heading or filename
  const firstH1 = tree.children.find(
    (node): node is Heading => node.type === 'heading' && (node as Heading).depth === 1,
  );
  const tabLabel = firstH1
    ? extractPlainText(firstH1)
    : 'Documentation';

  const tabSlug = tabLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    label: tabLabel,
    slug: tabSlug,
    sourceFile,
    groups,
  };
}

/**
 * Read a SUMMARY.md file from disk and parse it into a NavTab.
 *
 * @param filePath Absolute or relative path to the SUMMARY.md file.
 * @returns The parsed NavTab.
 */
export async function parseSummaryFile(filePath: string): Promise<NavTab> {
  const content = await readFile(filePath, 'utf-8');
  return parseSummary(content, filePath);
}

/**
 * Parse multiple SUMMARY.md files (for multi-tab documentation sites).
 *
 * @param filePaths Array of paths to SUMMARY.md files.
 * @returns Array of NavTab structures, one per file.
 */
export async function parseMultipleSummaries(
  filePaths: string[],
): Promise<NavTab[]> {
  return Promise.all(filePaths.map((fp) => parseSummaryFile(fp)));
}
