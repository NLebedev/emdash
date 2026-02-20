import { describe, expect, it } from 'vitest';
import { isBinaryFile, isImageFile } from '../../renderer/lib/diffUtils';

describe('diffUtils image detection', () => {
  it('detects common image extensions regardless of case', () => {
    expect(isImageFile('assets/logo.png')).toBe(true);
    expect(isImageFile('assets/photo.JPG')).toBe(true);
    expect(isImageFile('assets/icon.svg')).toBe(true);
    expect(isImageFile('assets/favicon.ICO')).toBe(true);
  });

  it('returns false for non-image files', () => {
    expect(isImageFile('src/main.ts')).toBe(false);
    expect(isImageFile('README.md')).toBe(false);
    expect(isImageFile('archive.zip')).toBe(false);
  });

  it('treats previewable images as binary files too', () => {
    const candidates = ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.svg', 'f.webp', 'g.ico'];
    for (const filePath of candidates) {
      expect(isImageFile(filePath)).toBe(true);
      expect(isBinaryFile(filePath)).toBe(true);
    }
  });
});
