import type { GitBookPage, GitBookFile } from '../types.js';
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
