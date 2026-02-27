import type { GitBookPage, GitBookFile, GitBookPageContent } from '../types.js';
import type { GitBookClient } from './client.js';

/**
 * Fetch the full page tree for a space.
 *
 * Returns a flat array of top-level pages; each page may contain nested
 * `pages` children.
 */
export async function fetchSpacePages(
  client: GitBookClient,
  spaceId: string,
): Promise<GitBookPage[]> {
  const body = await client.get<{ pages: GitBookPage[] }>(
    `/spaces/${spaceId}/content`,
  );
  return body.pages;
}

/**
 * Fetch all files (images, attachments, etc.) uploaded to a space.
 *
 * Collects every page from the paginated `/files` endpoint into a
 * single array.
 */
export async function fetchSpaceFiles(
  client: GitBookClient,
  spaceId: string,
): Promise<GitBookFile[]> {
  const files: GitBookFile[] = [];

  for await (const file of client.paginate<GitBookFile>(
    `/spaces/${spaceId}/content/files`,
  )) {
    files.push(file);
  }

  return files;
}

/**
 * Fetch the rich document content for a single page.
 *
 * Uses the `GET /spaces/{spaceId}/content/page/{pageId}` endpoint which
 * returns structured block content (tabs, hints, embeds, etc.) that the
 * scraper cannot reliably extract from rendered HTML.
 */
export async function fetchPageContent(
  client: GitBookClient,
  spaceId: string,
  pageId: string,
): Promise<GitBookPageContent> {
  return client.get<GitBookPageContent>(
    `/spaces/${spaceId}/content/page/${pageId}`,
  );
}
