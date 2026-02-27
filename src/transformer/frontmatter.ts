/**
 * Generate YAML frontmatter for Mintlify MDX pages.
 *
 * Title and description are resolved with a priority chain so that
 * explicit API metadata wins over parsed page metadata.
 */

import type { ParsedPage } from '../types.js';

export interface ApiMetadata {
  title?: string;
  description?: string;
}

/**
 * Build a `---` delimited YAML frontmatter block for a Mintlify MDX page.
 *
 * @param page         - The parsed source page.
 * @param apiMetadata  - Optional title / description coming from the API.
 * @param openapiRef   - If present, adds an `openapi` field (e.g. `"GET /pets"`).
 */
export function generateFrontmatter(
  page: ParsedPage,
  apiMetadata?: ApiMetadata,
  openapiRef?: string,
): string {
  const title = resolveTitle(page, apiMetadata);
  const description = resolveDescription(page, apiMetadata);

  const lines: string[] = ['---'];

  lines.push(`title: ${yamlQuote(title)}`);

  if (description) {
    lines.push(`description: ${yamlQuote(description)}`);
  }

  if (openapiRef) {
    lines.push(`openapi: ${yamlQuote(openapiRef)}`);
  }

  lines.push('---');

  return lines.join('\n');
}

// ── Resolution helpers ───────────────────────────────────────────────

/**
 * Title priority:
 *   1. apiMetadata.title
 *   2. page.frontmatter.title
 *   3. page.title (typically extracted from the first H1)
 */
function resolveTitle(page: ParsedPage, apiMetadata?: ApiMetadata): string {
  if (apiMetadata?.title) return apiMetadata.title;
  if (typeof page.frontmatter['title'] === 'string' && page.frontmatter['title']) {
    return page.frontmatter['title'] as string;
  }
  return page.title || 'Untitled';
}

/**
 * Description priority:
 *   1. apiMetadata.description
 *   2. page.frontmatter.description
 *   3. First paragraph of rawBody (best-effort extraction)
 */
function resolveDescription(
  page: ParsedPage,
  apiMetadata?: ApiMetadata,
): string | undefined {
  if (apiMetadata?.description) return apiMetadata.description;
  if (typeof page.frontmatter['description'] === 'string' && page.frontmatter['description']) {
    return page.frontmatter['description'] as string;
  }
  return extractFirstParagraph(page.rawBody);
}

/**
 * Very lightweight first-paragraph extractor.
 *
 * Skips leading blank lines, heading lines (`#`), and frontmatter fences.
 * Returns the first non-empty, non-heading line (trimmed) or `undefined`.
 */
function extractFirstParagraph(body: string): string | undefined {
  const lines = body.split('\n');
  let inFrontmatter = false;

  for (const raw of lines) {
    const line = raw.trim();

    // Skip frontmatter fences
    if (line === '---') {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;

    // Skip blanks and headings
    if (!line || line.startsWith('#')) continue;

    // Skip GitBook block markers
    if (line.startsWith('{%') || line.startsWith('%}')) continue;

    return line;
  }

  return undefined;
}

// ── YAML helpers ─────────────────────────────────────────────────────

/**
 * Quote a YAML scalar value.  Uses double-quotes when the value contains
 * characters that would be ambiguous in bare YAML (colons, quotes, etc.).
 */
function yamlQuote(value: string): string {
  // If it contains characters that need quoting, wrap in double quotes
  // and escape internal double-quotes and backslashes.
  if (/[:#\[\]{}&*!|>'"%@`,?\\\n]/.test(value) || value.trim() !== value) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return `"${value}"`;
}
