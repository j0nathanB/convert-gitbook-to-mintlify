import type { GitBookOpenAPISpec } from '../types.js';
import type { GitBookClient } from './client.js';

/**
 * Fetch the list of OpenAPI specs registered under an organization.
 *
 * Collects every item from the paginated endpoint into a single array.
 */
export async function fetchOpenAPISpecs(
  client: GitBookClient,
  orgId: string,
): Promise<GitBookOpenAPISpec[]> {
  const specs: GitBookOpenAPISpec[] = [];

  for await (const spec of client.paginate<GitBookOpenAPISpec>(
    `/orgs/${orgId}/openapi`,
  )) {
    specs.push(spec);
  }

  return specs;
}

/**
 * Fetch a single OpenAPI spec by its ID.
 *
 * Returns the raw spec object (OpenAPI JSON or YAML parsed as JSON)
 * without imposing a specific type, since the shape varies per spec.
 */
export async function fetchOpenAPISpec(
  client: GitBookClient,
  orgId: string,
  specId: string,
): Promise<any> {
  return client.get<any>(`/orgs/${orgId}/openapi/${specId}`);
}
