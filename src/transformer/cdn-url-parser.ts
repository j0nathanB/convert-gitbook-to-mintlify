/**
 * Parse GitBook CDN image URLs and extract original source information.
 *
 * GitBook proxies images through a CDN with URLs like:
 *   https://XXXX.gitbook.io/~gitbook/image?url=<encoded-original>&width=...&dpr=...
 *
 * This module detects that pattern, decodes the original URL, and extracts
 * a usable filename for the local image asset.
 */

const CDN_PATTERN = /\.gitbook\.io\/~gitbook\/image/;

/** Parameters added by the GitBook CDN that we strip. */
const CDN_PARAMS = new Set(['width', 'dpr', 'quality', 'sign', 'sv']);

export interface CdnParseResult {
  /** The decoded original image URL (before CDN wrapping). */
  originalUrl: string;
  /** Best-effort filename extracted from the original URL. */
  filename: string;
}

/**
 * Detect a GitBook CDN image URL and extract the original source URL
 * and filename.
 *
 * Returns `null` when `url` is not a GitBook CDN URL.
 */
export function parseCdnUrl(url: string): CdnParseResult | null {
  if (!CDN_PATTERN.test(url)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const encodedOriginal = parsed.searchParams.get('url');
  if (!encodedOriginal) {
    return null;
  }

  const originalUrl = decodeURIComponent(encodedOriginal);

  // Strip CDN-specific params to get a clean URL
  for (const param of CDN_PARAMS) {
    parsed.searchParams.delete(param);
  }

  const filename = extractFilename(originalUrl);

  return { originalUrl, filename };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract a filename from a URL path, falling back to a generic name
 * when the URL has no obvious file segment.
 */
function extractFilename(url: string): string {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /\.\w+$/.test(last)) {
      return decodeURIComponent(last);
    }
  } catch {
    // If `url` is not a valid absolute URL, try a simple split
    const parts = url.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /\.\w+$/.test(last)) {
      return decodeURIComponent(last.split('?')[0]);
    }
  }

  return 'image.png';
}
