import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import type { ParsedPage, GitBookBlockRef } from '../types.js';
import { logger } from '../utils/logger.js';

// ─── GitBook Block Inventory ───

/**
 * Scan markdown source for all `{% type ... %}` GitBook block opening tags
 * and return a structured inventory.
 *
 * This uses a simple character-level scan to find opening tags only (not the
 * full tokenizer). Each entry records the block type, its style/attributes,
 * and the 1-based line number.
 */
function inventoryGitBookBlocks(source: string): GitBookBlockRef[] {
  const refs: GitBookBlockRef[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let pos = 0;

    while (pos < line.length) {
      const openIdx = line.indexOf('{%', pos);
      if (openIdx === -1) break;

      const closeIdx = line.indexOf('%}', openIdx + 2);
      if (closeIdx === -1) {
        pos = openIdx + 2;
        continue;
      }

      const body = line.slice(openIdx + 2, closeIdx).trim();

      // Skip closing tags (endXxx)
      if (body.startsWith('end')) {
        pos = closeIdx + 2;
        continue;
      }

      // Extract type (first whitespace-delimited token)
      const spaceIdx = body.search(/\s/);
      const type = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? '' : body.slice(spaceIdx);

      // Extract style attribute (commonly used in hint blocks)
      const styleMatch = rest.match(/style=["']([^"']*)["']/);
      const style = styleMatch ? styleMatch[1] : undefined;

      // Extract all key="value" attributes
      const attributes: Record<string, string> = {};
      const attrRegex = /(\w[\w-]*)=["']([^"']*)["']/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(rest)) !== null) {
        attributes[attrMatch[1]] = attrMatch[2];
      }

      refs.push({
        type,
        style,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        line: i + 1, // 1-based
      });

      pos = closeIdx + 2;
    }
  }

  return refs;
}

// ─── Image Inventory ───

/**
 * Extract all image references from markdown source.
 *
 * Finds both standard markdown image syntax `![alt](url)` and HTML `<img>`
 * tags. Returns deduplicated source paths/URLs.
 */
function inventoryImages(source: string): string[] {
  const images = new Set<string>();

  // Markdown images: ![alt](url)
  const mdImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdImageRegex.exec(source)) !== null) {
    const url = match[1].split(/\s+/)[0]; // strip optional title
    images.add(url);
  }

  // HTML img tags: <img ... src="url" ...>
  const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlImgRegex.exec(source)) !== null) {
    images.add(match[1]);
  }

  return [...images];
}

// ─── Internal Link Inventory ───

/**
 * Extract all internal links (relative `.md` references) from markdown source.
 *
 * Matches standard markdown links `[text](path.md)` and `[text](path.md#anchor)`.
 * Skips external URLs (http://, https://, mailto:, etc.) and anchor-only links.
 */
function inventoryInternalLinks(source: string): string[] {
  const links = new Set<string>();

  // Markdown links: [text](url)
  // Negative lookbehind for `!` to skip images.
  const linkRegex = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(source)) !== null) {
    let url = match[1].split(/\s+/)[0]; // strip optional title

    // Skip external URLs and anchor-only links
    if (/^(https?:|mailto:|tel:|#)/.test(url)) continue;

    // Strip anchor fragments for the file path
    const hashIdx = url.indexOf('#');
    if (hashIdx > 0) {
      url = url.slice(0, hashIdx);
    }

    // Only include .md file references
    if (url.endsWith('.md') || url.endsWith('.md/')) {
      links.add(url);
    }
  }

  return [...links];
}

// ─── Title Extraction ───

/**
 * Extract the first H1 heading from markdown source as a fallback title.
 * Returns `undefined` if no H1 is found.
 */
function extractFirstH1(source: string): string | undefined {
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }
  return undefined;
}

// ─── Public API ───

/**
 * Read a markdown file, extract frontmatter, title, and inventory all
 * GitBook blocks, images, and internal links.
 *
 * @param filePath Absolute or relative path to the markdown file.
 * @returns A ParsedPage with all extracted metadata.
 */
export async function readMarkdownFile(filePath: string): Promise<ParsedPage> {
  const raw = await readFile(filePath, 'utf-8');
  const { data: frontmatter, content: rawBody } = matter(raw);

  // Determine title: frontmatter title > first H1 > filename
  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title : undefined;
  const h1Title = extractFirstH1(rawBody);
  const title = fmTitle ?? h1Title ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled';

  const gitbookBlocks = inventoryGitBookBlocks(rawBody);
  const images = inventoryImages(rawBody);
  const internalLinks = inventoryInternalLinks(rawBody);

  if (gitbookBlocks.length > 0) {
    logger.debug(`Found ${gitbookBlocks.length} GitBook block(s) in ${filePath}`);
  }

  return {
    path: filePath,
    title,
    frontmatter: frontmatter as Record<string, unknown>,
    rawBody,
    gitbookBlocks,
    images,
    internalLinks,
  };
}

/**
 * Read multiple markdown files relative to a base path.
 *
 * @param basePath  The base directory all `filePaths` are relative to.
 * @param filePaths Array of relative file paths within `basePath`.
 * @returns Array of ParsedPage results. Files that fail to read are logged
 *          as warnings and excluded from the result.
 */
export async function readAllMarkdownFiles(
  basePath: string,
  filePaths: string[],
): Promise<ParsedPage[]> {
  const results: ParsedPage[] = [];

  for (const fp of filePaths) {
    const fullPath = resolve(basePath, fp);
    try {
      const page = await readMarkdownFile(fullPath);
      results.push(page);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to read ${fullPath}: ${message}`);
    }
  }

  return results;
}
