/**
 * Main Markdown -> Mintlify MDX conversion pipeline.
 *
 * Orchestrates all transformer sub-modules in the correct order:
 *   1. Tokenize GitBook blocks
 *   2. Convert blocks to Mintlify components
 *   3. Sanitize for MDX
 *   4. Rewrite internal links
 *   5. Rewrite image paths
 *   6. Generate frontmatter
 *   7. Optionally strip the first H1
 *   8. Combine frontmatter + body
 */

import type { ParsedPage } from '../types.js';
import { tokenize } from '../parsers/block-tokenizer.js';
import { convertBlock } from './block-converter.js';
import { sanitizeMdx } from './mdx-sanitizer.js';
import { rewriteLinks, rewriteImagePaths } from './link-rewriter.js';
import { generateFrontmatter } from './frontmatter.js';

export interface ConvertToMdxOptions {
  /** Map from old internal link paths to new Mintlify paths. */
  linkMap: Map<string, string>;
  /** Map from old image paths to new image paths. */
  imageMap: Map<string, string>;
  /** Whether to strip the first H1 when it matches the page title. */
  removeFirstH1: boolean;
  /** Optional API-sourced metadata that takes priority. */
  apiMetadata?: { title?: string; description?: string };
  /** If present, add `openapi: "METHOD /path"` to frontmatter. */
  openapiRef?: string;
  /** When true, throw on unrecognized blocks instead of passing them through. */
  strict?: boolean;
}

/**
 * Convert a `ParsedPage` into a complete Mintlify MDX string, ready to
 * be written to disk.
 */
export function convertToMdx(page: ParsedPage, options: ConvertToMdxOptions): string {
  const {
    linkMap,
    imageMap,
    removeFirstH1,
    apiMetadata,
    openapiRef,
  } = options;

  // --- Step 1: Tokenize GitBook blocks --------------------------------
  const { tokens } = tokenize(page.rawBody, options.strict);

  // --- Step 2: Convert blocks to Mintlify components ------------------
  // Replace each token's raw text in the body with its converted MDX.
  let body = page.rawBody;
  if (tokens.length > 0) {
    // Process tokens in reverse order of appearance to preserve offsets.
    const sorted = [...tokens].sort((a, b) => {
      const aStart = body.indexOf(a.raw);
      const bStart = body.indexOf(b.raw);
      return bStart - aStart;
    });
    for (const token of sorted) {
      const converted = convertBlock(token);
      const idx = body.indexOf(token.raw);
      if (idx >= 0) {
        body = body.slice(0, idx) + converted + body.slice(idx + token.raw.length);
      }
    }
  }

  // --- Step 3: Sanitize for MDX ---------------------------------------
  body = sanitizeMdx(body);

  // --- Step 4: Rewrite internal links ---------------------------------
  body = rewriteLinks(body, linkMap);

  // --- Step 5: Rewrite image paths ------------------------------------
  body = rewriteImagePaths(body, imageMap);

  // --- Step 6: Generate frontmatter -----------------------------------
  const frontmatter = generateFrontmatter(page, apiMetadata, openapiRef);

  // --- Step 7: Remove first H1 if it matches the page title ----------
  if (removeFirstH1) {
    body = stripFirstH1IfMatchesTitle(body, page, apiMetadata);
  }

  // --- Step 8: Combine frontmatter + body -----------------------------
  // Ensure exactly one blank line between frontmatter and body.
  const trimmedBody = body.replace(/^\n+/, '');
  return `${frontmatter}\n\n${trimmedBody}\n`;
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Remove the first `# Heading` line from `body` when it matches the
 * resolved page title.
 *
 * Title resolution mirrors `frontmatter.ts`:
 *   apiMetadata.title > page.frontmatter.title > page.title
 */
function stripFirstH1IfMatchesTitle(
  body: string,
  page: ParsedPage,
  apiMetadata?: { title?: string; description?: string },
): string {
  const resolvedTitle = (
    apiMetadata?.title ||
    (typeof page.frontmatter['title'] === 'string' ? page.frontmatter['title'] : '') ||
    page.title
  ).trim();

  if (!resolvedTitle) return body;

  // Match the first H1 (ATX style): `# Some Title` possibly with trailing `#`s
  const h1Re = /^#\s+(.+?)(?:\s+#+)?\s*$/m;
  const match = h1Re.exec(body);

  if (match) {
    const h1Text = match[1].trim();
    if (normalize(h1Text) === normalize(resolvedTitle)) {
      // Remove the matched line (and up to one trailing blank line)
      body = body.slice(0, match.index) + body.slice(match.index + match[0].length);
      body = body.replace(/^\n{2,}/, '\n');
    }
  }

  return body;
}

/**
 * Normalize a string for loose title comparison: lowercase, collapse
 * whitespace, strip leading/trailing whitespace.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
