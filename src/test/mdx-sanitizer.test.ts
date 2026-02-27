import { describe, it, expect } from 'vitest';
import { sanitizeMdx } from '../transformer/mdx-sanitizer.js';

describe('mdx-sanitizer', () => {
  it('should escape angle brackets in prose', () => {
    const input = 'x < 10 and y > 5';
    const result = sanitizeMdx(input);
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
  });

  it('should preserve JSX-style tags', () => {
    const input = '<Info>some text</Info>';
    const result = sanitizeMdx(input);
    expect(result).toContain('<Info>');
    expect(result).toContain('</Info>');
  });

  it('should escape curly braces in prose', () => {
    const input = 'Use {config} for settings';
    const result = sanitizeMdx(input);
    expect(result).toContain('\\{config\\}');
  });

  it('should convert HTML comments to MDX comments', () => {
    const input = '<!-- This is a comment -->';
    const result = sanitizeMdx(input);
    expect(result).toContain('{/*');
    expect(result).toContain('*/}');
    expect(result).not.toContain('<!--');
  });

  it('should not modify content inside fenced code blocks', () => {
    const input = '```\nx < 10 and {config}\n```';
    const result = sanitizeMdx(input);
    expect(result).toContain('x < 10');
    expect(result).toContain('{config}');
  });

  it('should not modify content inside inline code', () => {
    const input = 'Use `x < 10` in your code';
    const result = sanitizeMdx(input);
    expect(result).toContain('`x < 10`');
  });
});
