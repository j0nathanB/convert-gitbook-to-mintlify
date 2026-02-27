import { logger } from './logger.js';

/**
 * Configuration for retry behavior with exponential backoff.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries: number;
  /** Initial delay in milliseconds before the first retry (default: 1000). */
  initialDelayMs: number;
  /** Maximum delay in milliseconds between retries (default: 30000). */
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Returns true if the HTTP status code is retryable (429 or 5xx).
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Compute the delay for the next retry using exponential backoff with jitter.
 * If the response includes a `Retry-After` header, that value is respected
 * as a minimum delay.
 */
function computeDelay(
  attempt: number,
  config: RetryConfig,
  response?: Response,
): number {
  // Exponential backoff: initialDelay * 2^attempt
  const exponentialDelay = config.initialDelayMs * Math.pow(2, attempt);

  // Add random jitter: +/- 25% of the exponential delay
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  let delay = exponentialDelay + jitter;

  // Respect Retry-After header if present
  if (response) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const retryAfterSeconds = Number(retryAfter);
      if (!Number.isNaN(retryAfterSeconds)) {
        // Retry-After is in seconds; convert to ms
        const retryAfterMs = retryAfterSeconds * 1000;
        delay = Math.max(delay, retryAfterMs);
      } else {
        // Retry-After may be an HTTP-date
        const retryDate = Date.parse(retryAfter);
        if (!Number.isNaN(retryDate)) {
          const retryAfterMs = retryDate - Date.now();
          if (retryAfterMs > 0) {
            delay = Math.max(delay, retryAfterMs);
          }
        }
      }
    }
  }

  // Clamp to maxDelayMs
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL with automatic retry on transient failures.
 *
 * Retries on HTTP 429 (Too Many Requests) and 5xx (Server Error) responses
 * using exponential backoff with jitter. The `Retry-After` response header is
 * respected when present.
 *
 * @param url - The URL to fetch.
 * @param options - Standard `RequestInit` options forwarded to `fetch`.
 * @param retryConfig - Optional retry configuration overrides.
 * @returns The `Response` from a successful (non-retryable) fetch.
 * @throws The last error encountered if all retry attempts are exhausted.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retryConfig: Partial<RetryConfig> = {},
): Promise<Response> {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!isRetryableStatus(response.status)) {
        return response;
      }

      // Retryable status -- log and prepare to retry
      lastResponse = response;
      logger.debug(
        `HTTP ${response.status} from ${url} (attempt ${attempt + 1}/${config.maxRetries + 1})`,
      );

      if (attempt < config.maxRetries) {
        const delay = computeDelay(attempt, config, response);
        logger.debug(`Retrying in ${Math.round(delay)}ms...`);
        await sleep(delay);
      }
    } catch (error: unknown) {
      // Network errors (DNS, connection refused, etc.) are also retryable
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(
        `Fetch error for ${url}: ${message} (attempt ${attempt + 1}/${config.maxRetries + 1})`,
      );

      if (attempt < config.maxRetries) {
        const delay = computeDelay(attempt, config);
        logger.debug(`Retrying in ${Math.round(delay)}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  if (lastResponse) {
    return lastResponse;
  }

  throw lastError;
}
