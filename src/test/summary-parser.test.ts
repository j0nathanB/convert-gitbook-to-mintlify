import { describe, it, expect } from 'vitest';
import { parseSummary } from '../parsers/summary-parser.js';

describe('summary-parser', () => {
  it('should parse a simple SUMMARY.md', () => {
    const content = `# Documentation

## Getting Started

* [Introduction](getting-started/introduction.md)
* [Quick Start](getting-started/quick-start.md)

## Advanced

* [Configuration](advanced/configuration.md)
`;
    const result = parseSummary(content, 'SUMMARY.md');
    expect(result.label).toBe('Documentation');
    expect(result.slug).toBe('documentation');
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].label).toBe('Getting Started');
    expect(result.groups[0].pages).toHaveLength(2);
    expect(result.groups[0].pages[0].label).toBe('Introduction');
    expect(result.groups[0].pages[0].path).toBe('getting-started/introduction.md');
    expect(result.groups[1].label).toBe('Advanced');
    expect(result.groups[1].pages).toHaveLength(1);
  });

  it('should handle nested lists as sub-groups', () => {
    const content = `# Docs

* [Overview](overview.md)
  * [Sub Page](sub-page.md)
`;
    const result = parseSummary(content, 'SUMMARY.md');
    expect(result.groups).toHaveLength(1);
    // The Overview item should become a sub-group with its link and children
  });

  it('should default to Documentation when no H1', () => {
    const content = `## Group
* [Page](page.md)
`;
    const result = parseSummary(content, 'SUMMARY.md');
    expect(result.label).toBe('Documentation');
  });
});
