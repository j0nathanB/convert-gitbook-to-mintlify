import { fetchWithRetry } from '../utils/http.js';

const USER_AGENT = 'gitbook-to-mintlify/1.0';

/**
 * Lightweight wrapper around the GitBook REST API.
 *
 * Every request is routed through `fetchWithRetry` so transient
 * network errors and rate-limit responses are handled automatically.
 */
export class GitBookClient {
  readonly #token: string;
  readonly #baseUrl: string;

  constructor(token: string, baseUrl = 'https://api.gitbook.com/v1') {
    this.#token = token;
    // Strip trailing slash so callers can use paths like `/orgs/…`
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Perform a GET request against the GitBook API and return the
   * parsed JSON body typed as `T`.
   */
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = this.#buildUrl(path, params);

    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: this.#headers(),
    });

    return (await response.json()) as T;
  }

  /**
   * Paginate through a GitBook list endpoint.
   *
   * GitBook uses cursor-based pagination: the response contains a `next`
   * object with a `page` cursor when there are more results. Each page
   * body also has an `items` array.
   */
  async *paginate<T>(
    path: string,
    params?: Record<string, string>,
  ): AsyncGenerator<T> {
    let cursor: string | undefined;

    do {
      const query: Record<string, string> = { ...params };
      if (cursor) {
        query['page'] = cursor;
      }

      const body = await this.get<{
        items: T[];
        next?: { page: string };
      }>(path, query);

      for (const item of body.items) {
        yield item;
      }

      cursor = body.next?.page;
    } while (cursor);
  }

  // ── Private helpers ──────────────────────────────────────────────

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };
  }

  #buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.#baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }
}
