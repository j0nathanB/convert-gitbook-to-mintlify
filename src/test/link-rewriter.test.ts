import { describe, it, expect } from 'vitest';
import { rewriteLinks, rewriteImagePaths } from '../transformer/link-rewriter.js';

describe('link-rewriter', () => {
  it('should rewrite internal .md links', () => {
    const linkMap = new Map([
      ['getting-started/intro.md', '/guides/getting-started/intro'],
    ]);
    const content = 'See [intro](getting-started/intro.md) for details.';
    const result = rewriteLinks(content, linkMap);
    expect(result).toContain('/guides/getting-started/intro');
    expect(result).not.toContain('.md');
  });

  it('should preserve anchors', () => {
    const linkMap = new Map([
      ['page.md', '/page'],
    ]);
    const content = 'See [section](page.md#section) for details.';
    const result = rewriteLinks(content, linkMap);
    expect(result).toContain('/page#section');
  });

  it('should not rewrite external links', () => {
    const linkMap = new Map<string, string>();
    const content = 'Visit [Google](https://google.com).';
    const result = rewriteLinks(content, linkMap);
    expect(result).toContain('https://google.com');
  });
});

describe('image-rewriter', () => {
  it('should rewrite image paths', () => {
    const imageMap = new Map([
      ['.gitbook/assets/screenshot.png', '/images/screenshot.png'],
    ]);
    const content = '![Screenshot](.gitbook/assets/screenshot.png)';
    const result = rewriteImagePaths(content, imageMap);
    expect(result).toContain('/images/screenshot.png');
  });
});
