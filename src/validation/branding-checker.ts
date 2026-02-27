/**
 * Validate docs.json branding fields for completeness.
 *
 * Checks that essential branding fields are present and non-empty:
 *  - name
 *  - colors.primary
 *  - logo (at least one of light or dark)
 *  - favicon
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DocsJson } from '../types.js';
import type { ValidationResult } from './runner.js';

/**
 * Check branding completeness in docs.json.
 */
export async function checkBranding(outputDir: string): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = [];

  const docsJsonPath = join(outputDir, 'docs.json');
  let docsJson: DocsJson;

  try {
    const raw = await readFile(docsJsonPath, 'utf-8');
    docsJson = JSON.parse(raw) as DocsJson;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      errors: [{ field: 'docs.json', error: `Failed to read or parse docs.json: ${message}` }],
    };
  }

  // Check: name field is present and non-empty.
  if (!docsJson.name || docsJson.name.trim() === '') {
    errors.push({
      field: 'name',
      error: 'Missing or empty "name" field in docs.json',
    });
  }

  // Check: colors.primary is present and non-empty.
  if (!docsJson.colors?.primary || docsJson.colors.primary.trim() === '') {
    errors.push({
      field: 'colors.primary',
      error: 'Missing or empty "colors.primary" field in docs.json',
    });
  }

  // Check: logo has at least one of light or dark.
  if (!docsJson.logo) {
    errors.push({
      field: 'logo',
      error: 'Missing "logo" field in docs.json',
    });
  } else {
    const hasLight = typeof docsJson.logo.light === 'string' && docsJson.logo.light.trim() !== '';
    const hasDark = typeof docsJson.logo.dark === 'string' && docsJson.logo.dark.trim() !== '';
    if (!hasLight && !hasDark) {
      errors.push({
        field: 'logo',
        error: 'Logo must have at least one of "light" or "dark" defined and non-empty',
      });
    }
  }

  // Check: favicon is present and non-empty.
  if (!docsJson.favicon || docsJson.favicon.trim() === '') {
    errors.push({
      field: 'favicon',
      error: 'Missing or empty "favicon" field in docs.json',
    });
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}
