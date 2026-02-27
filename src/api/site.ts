import type {
  GitBookSitePublished,
  GitBookCustomization,
  GitBookRedirect,
} from '../types.js';
import type { GitBookClient } from './client.js';

/**
 * Fetch the published site manifest for a given site.
 *
 * Returns the full site object including structure, customization, and
 * scripts.
 */
export async function fetchSitePublished(
  client: GitBookClient,
  orgId: string,
  siteId: string,
): Promise<GitBookSitePublished> {
  return client.get<GitBookSitePublished>(
    `/orgs/${orgId}/sites/${siteId}/published`,
  );
}

/**
 * Fetch the top-level site customization (branding, colors, fonts, etc.).
 */
export async function fetchSiteCustomization(
  client: GitBookClient,
  orgId: string,
  siteId: string,
): Promise<GitBookCustomization> {
  return client.get<GitBookCustomization>(
    `/orgs/${orgId}/sites/${siteId}/customization`,
  );
}

/**
 * Fetch all redirect rules configured for the site.
 */
export async function fetchSiteRedirects(
  client: GitBookClient,
  orgId: string,
  siteId: string,
): Promise<GitBookRedirect[]> {
  const body = await client.get<{ items: GitBookRedirect[] }>(
    `/orgs/${orgId}/sites/${siteId}/redirects`,
  );
  return body.items ?? [];
}

/**
 * Fetch the customization for a specific site-space (variant / section space).
 */
export async function fetchSiteSpaceCustomization(
  client: GitBookClient,
  orgId: string,
  siteId: string,
  siteSpaceId: string,
): Promise<GitBookCustomization> {
  return client.get<GitBookCustomization>(
    `/orgs/${orgId}/sites/${siteId}/site-spaces/${siteSpaceId}/customization`,
  );
}
