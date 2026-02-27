import { describe, it, expect } from 'vitest';
import { parseCdnUrl } from '../transformer/cdn-url-parser.js';

describe('cdn-url-parser', () => {
  it('should parse a GitBook CDN URL', () => {
    const url =
      'https://example.gitbook.io/~gitbook/image?url=https%3A%2F%2Foriginal-host.com%2Fimage.png&width=768&dpr=4&quality=100&sign=abc123&sv=2';
    const result = parseCdnUrl(url);
    expect(result).not.toBeNull();
    expect(result!.originalUrl).toBe('https://original-host.com/image.png');
    expect(result!.filename).toBe('image.png');
  });

  it('should return null for non-CDN URLs', () => {
    const url = 'https://example.com/images/photo.jpg';
    const result = parseCdnUrl(url);
    expect(result).toBeNull();
  });

  it('should handle URLs without CDN params', () => {
    const url = 'https://docs.gitbook.io/~gitbook/image?url=https%3A%2F%2Fcdn.example.com%2Flogo.svg';
    const result = parseCdnUrl(url);
    expect(result).not.toBeNull();
    expect(result!.originalUrl).toBe('https://cdn.example.com/logo.svg');
    expect(result!.filename).toBe('logo.svg');
  });
});
