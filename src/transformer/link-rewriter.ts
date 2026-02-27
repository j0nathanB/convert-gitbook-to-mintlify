/**
 * Rewrite internal links and image paths in Markdown / MDX content.
 *
 * After migration the file layout changes, so all internal cross-references
 * need to be updated from their GitBook paths to Mintlify slugs.  Image
 * assets are similarly relocated.
 */

/**
 * Rewrite markdown-style links whose target is a key in `linkMap`.
 *
 * Handles:
 *   - `[text](old-path.md)` -> `[text](/new-path)`
 *   - `[text](old-path.md#section)` -> `[text](/new-path#section)`
 *   - Strips `.md` extensions from targets even when not in the map.
 *   - Leaves external (http/https) links untouched.
 *   - Leaves anchor-only links (`#section`) untouched.
 */
export function rewriteLinks(
  content: string,
  linkMap: Map<string, string>,
): string {
  // Match markdown links: [text](target)
  // Also matches reference-style links won't be affected because they use [text][ref].
  return content.replace(
    /\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, text: string, rawTarget: string) => {
      const rewritten = rewriteSingleLink(rawTarget, linkMap);
      return `[${text}](${rewritten})`;
    },
  );
}

/**
 * Rewrite image paths in Markdown content using the provided `imageMap`.
 *
 * Handles:
 *   - `![alt](.gitbook/assets/img.png)` -> `![alt](/images/img.png)`
 *   - Also rewrites `<img src="...">` tags.
 */
export function rewriteImagePaths(
  content: string,
  imageMap: Map<string, string>,
): string {
  // Markdown images: ![alt](path)
  let result = content.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt: string, rawPath: string) => {
      const newPath = resolveImagePath(rawPath.trim(), imageMap);
      return `![${alt}](${newPath})`;
    },
  );

  // HTML img tags: <img src="path" ...>
  result = result.replace(
    /(<img\s[^>]*?src=["'])([^"']+)(["'][^>]*>)/gi,
    (_match, before: string, rawPath: string, after: string) => {
      const newPath = resolveImagePath(rawPath.trim(), imageMap);
      return `${before}${newPath}${after}`;
    },
  );

  return result;
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Rewrite a single link target.
 */
function rewriteSingleLink(
  target: string,
  linkMap: Map<string, string>,
): string {
  // Leave external links alone
  if (/^https?:\/\//.test(target)) return target;

  // Leave anchor-only links alone
  if (target.startsWith('#')) return target;

  // Separate anchor from path
  const [pathPart, anchor] = splitAnchor(target);

  // Normalize: strip leading `./`, trailing `/`
  let normalized = pathPart.replace(/^\.\//, '').replace(/\/+$/, '');

  // Check the map (with and without .md extension)
  let mapped = linkMap.get(normalized);

  if (!mapped) {
    // Try adding .md if not present
    const withMd = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
    mapped = linkMap.get(withMd);
  }

  if (!mapped) {
    // Try without .md
    const withoutMd = normalized.replace(/\.md$/, '');
    mapped = linkMap.get(withoutMd);
  }

  if (mapped) {
    // Ensure the mapped path starts with /
    const resolved = mapped.startsWith('/') ? mapped : `/${mapped}`;
    return anchor ? `${resolved}#${anchor}` : resolved;
  }

  // Not in the map -- still strip .md for cleanliness
  normalized = normalized.replace(/\.md$/, '');
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }

  return anchor ? `${normalized}#${anchor}` : normalized;
}

/**
 * Split a link target into `[path, anchor]`.
 * e.g. `"page.md#section"` -> `["page.md", "section"]`
 */
function splitAnchor(target: string): [string, string | undefined] {
  const hashIdx = target.indexOf('#');
  if (hashIdx === -1) return [target, undefined];
  return [target.slice(0, hashIdx), target.slice(hashIdx + 1)];
}

/**
 * Resolve a single image path using the imageMap, falling back to the
 * original path.
 */
function resolveImagePath(
  rawPath: string,
  imageMap: Map<string, string>,
): string {
  // Exact match
  if (imageMap.has(rawPath)) {
    return imageMap.get(rawPath)!;
  }

  // Try without leading `./`
  const cleaned = rawPath.replace(/^\.\//, '');
  if (imageMap.has(cleaned)) {
    return imageMap.get(cleaned)!;
  }

  // Try decoding (URLs may be percent-encoded)
  try {
    const decoded = decodeURIComponent(cleaned);
    if (imageMap.has(decoded)) {
      return imageMap.get(decoded)!;
    }
  } catch {
    // ignore decode errors
  }

  return rawPath;
}
