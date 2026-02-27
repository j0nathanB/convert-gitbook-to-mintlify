/**
 * Validate that all images referenced in .mdx files exist.
 *
 * Scans for both markdown image syntax `![alt](path)` and HTML/JSX
 * `<img src="...">` tags.  Relative paths are checked against the output
 * directory.  Absolute URLs are optionally verified with a HEAD request.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { glob } from 'glob';

import type { ValidationResult } from './runner.js';

/**
 * Options for image checking.
 */
export interface ImageCheckOptions {
  /** When true, external URLs are verified with a HEAD request (default: false). */
  checkExternal?: boolean;
  /** Timeout in ms for external URL checks (default: 5000). */
  externalTimeoutMs?: number;
}

/**
 * Check all image references in .mdx files under `outputDir`.
 */
export async function checkImages(
  outputDir: string,
  options: ImageCheckOptions = {},
): Promise<ValidationResult> {
  const { checkExternal = false, externalTimeoutMs = 5000 } = options;
  const errors: ValidationResult['errors'] = [];

  const files = await glob('**/*.mdx', { cwd: outputDir, nodir: true });

  if (files.length === 0) {
    return { passed: true, errors: [] };
  }

  // Markdown image syntax: ![alt](path)
  const mdImageRe = /!\[(?:[^\]]*)\]\(([^)]+)\)/g;

  // HTML/JSX <img> tag src attribute.
  const imgTagRe = /<img\s[^>]*?src=["']([^"']+)["'][^>]*\/?>/gi;

  // Also catch Mintlify <Image> or <Frame> components with src.
  const componentSrcRe = /<(?:Image|Frame)\s[^>]*?src=["']([^"']+)["'][^>]*\/?>/gi;

  for (const file of files) {
    const fullPath = join(outputDir, file);
    const content = await readFile(fullPath, 'utf-8');
    const fileDir = dirname(file);

    const images = new Set<string>();

    for (const match of content.matchAll(mdImageRe)) {
      images.add(match[1].trim());
    }
    for (const match of content.matchAll(imgTagRe)) {
      images.add(match[1].trim());
    }
    for (const match of content.matchAll(componentSrcRe)) {
      images.add(match[1].trim());
    }

    for (const imagePath of images) {
      // Skip data URIs.
      if (imagePath.startsWith('data:')) {
        continue;
      }

      const isExternal = /^https?:\/\/|^\/\//i.test(imagePath);

      if (isExternal) {
        if (checkExternal) {
          const reachable = await checkExternalUrl(imagePath, externalTimeoutMs);
          if (!reachable) {
            errors.push({
              file,
              image: imagePath,
              error: `External image URL is unreachable: ${imagePath}`,
            });
          }
        }
        continue;
      }

      // Resolve relative path.
      let resolved: string;
      if (imagePath.startsWith('/')) {
        // Absolute path within the docs root.
        resolved = imagePath.slice(1);
      } else {
        resolved = join(fileDir, imagePath);
      }

      if (!existsSync(join(outputDir, resolved))) {
        errors.push({
          file,
          image: imagePath,
          error: `Image file not found: ${resolved}`,
        });
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Perform a HEAD request to check if an external URL is reachable.
 */
async function checkExternalUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    // Normalize protocol-relative URLs.
    const fullUrl = url.startsWith('//') ? `https:${url}` : url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(fullUrl, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
