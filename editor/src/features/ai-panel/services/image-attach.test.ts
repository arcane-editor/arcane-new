import { describe, it, expect } from 'bun:test';
import { isImagePath, mimeForPath, basename, MAX_IMAGE_BYTES } from './image-attach';

describe('isImagePath', () => {
  it('accepts the extensions the picker offers', () => {
    for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp']) {
      expect(isImagePath(p)).toBe(true);
    }
  });

  it('ignores case, because a drop carries whatever the disk says', () => {
    expect(isImagePath('/refs/Moodboard.PNG')).toBe(true);
  });

  it('rejects everything else, so a dropped script is not read as a picture', () => {
    for (const p of ['a.cs', 'a.uxml', 'a.psd', 'a.svg', 'a', 'a.png.txt']) {
      expect(isImagePath(p)).toBe(false);
    }
  });
});

describe('mimeForPath', () => {
  it('maps jpg and jpeg to the same type', () => {
    expect(mimeForPath('a.jpg')).toBe('image/jpeg');
    expect(mimeForPath('a.jpeg')).toBe('image/jpeg');
  });

  it('falls back to png rather than to an empty type', () => {
    // An empty mime reaches the model as a malformed image block; png is the
    // guess most likely to decode.
    expect(mimeForPath('screenshot')).toBe('image/png');
  });
});

describe('basename', () => {
  it('is the label a staged image is shown under', () => {
    expect(basename('/Users/x/refs/Moodboard.png')).toBe('Moodboard.png');
    expect(basename('Moodboard.png')).toBe('Moodboard.png');
  });
});

describe('the size cap', () => {
  it('is 4MB — past that an image costs more context than it is worth', () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });
});
