/**
 * Validate that all MDX files in the output directory parse correctly.
 *
 * Uses the unified ecosystem (remark-parse + remark-mdx) to attempt parsing
 * each .mdx file.  Files that fail to parse are reported with error details
 * including the offending line number when available.
 *
 * Common failures: unescaped angle brackets, unescaped curly braces,
 * unclosed JSX components, and HTML comments that were not converted.
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { glob } from 'glob';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';

import type { ValidationResult } from './runner.js';

/**
 * Find all .mdx files in `outputDir` and attempt to parse each one.
 * Returns a ValidationResult indicating which files (if any) failed.
 */
export async function checkMdxFiles(outputDir: string): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = [];

  const files = await glob('**/*.mdx', { cwd: outputDir, nodir: true });

  if (files.length === 0) {
    return {
      passed: true,
      errors: [],
    };
  }

  const processor = unified().use(remarkParse).use(remarkMdx);

  for (const file of files) {
    const fullPath = join(outputDir, file);
    try {
      const content = await readFile(fullPath, 'utf-8');
      // Attempt to parse -- this will throw on invalid MDX syntax.
      processor.parse(content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // unified parse errors often include position info in the message or
      // as properties on the error object.
      let line: number | undefined;
      if (typeof (err as Record<string, unknown>)?.['line'] === 'number') {
        line = (err as Record<string, unknown>)['line'] as number;
      } else if (typeof (err as Record<string, unknown>)?.['position'] === 'object') {
        const pos = (err as Record<string, unknown>)['position'] as Record<string, unknown>;
        if (typeof pos?.['start'] === 'object') {
          const start = pos['start'] as Record<string, unknown>;
          if (typeof start?.['line'] === 'number') {
            line = start['line'] as number;
          }
        }
      }

      errors.push({
        file: relative(outputDir, fullPath),
        error: message,
        ...(line !== undefined ? { line } : {}),
      });
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}
