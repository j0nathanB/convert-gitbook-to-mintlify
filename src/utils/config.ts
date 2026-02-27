import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { MigrationConfig } from '../types.js';
import { logger } from './logger.js';

/**
 * Returns the default migration configuration.
 *
 * Every field is populated with a sensible default so the tool can run
 * without a configuration file for simple use-cases.
 */
export function getDefaultConfig(): MigrationConfig {
  return {
    api: {},
    output: './output',
    tabs: {},
    scraper: {
      enabled: false,
      delayMs: 500,
      concurrency: 2,
      sidebarExpansionRounds: 3,
      skipPaths: [],
      selectors: {
        sectionsNav: 'nav[aria-label="Main"] ul[data-gb-sections], nav#sections, [data-testid="space-header-section"]',
      },
    },
    transforms: {
      flattenSingleChildGroups: true,
      removeFirstH1: true,
      codeBlockDefaultLanguage: '',
      normalizeFilenames: true,
    },
    brandingOverrides: {},
    strict: false,
    dryRun: false,
    noPrompt: false,
  };
}

/**
 * Deep-merge two objects. Arrays are replaced (not concatenated).
 * `undefined` values in `overrides` are ignored so that absent CLI flags
 * do not clobber file-based configuration.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overrides: Record<string, unknown>,
): T {
  const result = { ...base } as Record<string, unknown>;

  for (const key of Object.keys(overrides)) {
    const overrideVal = overrides[key];

    // Skip undefined values so that unset CLI args don't wipe config-file values
    if (overrideVal === undefined) {
      continue;
    }

    const baseVal = result[key];

    if (
      baseVal !== null &&
      overrideVal !== null &&
      typeof baseVal === 'object' &&
      typeof overrideVal === 'object' &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }

  return result as T;
}

/**
 * Merge configuration from multiple sources with increasing priority:
 *   defaults < fileConfig < cliArgs
 *
 * @param defaults  - Base defaults (typically from `getDefaultConfig()`).
 * @param fileConfig - Values loaded from a configuration file.
 * @param cliArgs   - Values supplied via CLI flags (highest priority).
 * @returns A fully-merged `MigrationConfig`.
 */
export function mergeConfigs(
  defaults: MigrationConfig,
  fileConfig: Partial<MigrationConfig>,
  cliArgs: Partial<MigrationConfig>,
): MigrationConfig {
  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    fileConfig as unknown as Record<string, unknown>,
  );
  return deepMerge(
    merged as unknown as Record<string, unknown>,
    cliArgs as unknown as Record<string, unknown>,
  ) as unknown as MigrationConfig;
}

/**
 * Load a migration configuration from a JSON file on disk.
 *
 * @param configPath - Path to the config file. Defaults to `./migration.json`
 *                     resolved from the current working directory.
 * @returns A fully-resolved `MigrationConfig` (defaults merged with file values).
 */
export async function loadConfig(
  configPath?: string,
): Promise<MigrationConfig> {
  const resolvedPath = resolve(configPath ?? 'migration.json');
  const defaults = getDefaultConfig();

  let fileConfig: Partial<MigrationConfig> = {};

  try {
    const raw = await readFile(resolvedPath, 'utf-8');
    fileConfig = JSON.parse(raw) as Partial<MigrationConfig>;
    logger.debug(`Loaded config from ${resolvedPath}`);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      logger.debug(`No config file found at ${resolvedPath}, using defaults`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to read config at ${resolvedPath}: ${message}`);
    }
  }

  return mergeConfigs(defaults, fileConfig, {});
}
