import { describe, expect, it } from 'vitest';
import {
  analyzeBlank,
  compareImages,
  cropRows,
  dHash,
  flatFrameHash,
  hammingDistance,
  pHash,
  pixelChangeRatio,
  resizeGrey,
  type GreyImage,
} from '../src/image/hash.js';

const W = 108;
const H = 240;

/** A flat image, optionally with small deterministic noise (as JPEG leaves). */
function flat(value: number, noise = 0): GreyImage {
  const data = new Uint8Array(W * H);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const jitter = noise ? Math.round(((seed % 1000) / 1000 - 0.5) * 2 * noise) : 0;
    data[i] = Math.max(0, Math.min(255, value + jitter));
  }
  return { width: W, height: H, data };
}

/** Paint a dark rectangle (fractions of the image) onto a copy. */
function withBox(img: GreyImage, x1: number, y1: number, x2: number, y2: number, value = 40): GreyImage {
  const data = Uint8Array.from(img.data);
  for (let y = Math.floor(y1 * img.height); y < Math.floor(y2 * img.height); y++) {
    for (let x = Math.floor(x1 * img.width); x < Math.floor(x2 * img.width); x++) data[y * img.width + x] = value;
  }
  return { ...img, data };
}

/** A busy page: horizontal bands of alternating shade, like a list. */
function stripes(): GreyImage {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.floor(y / 20) % 2 ? 230 : 60;
  return { width: W, height: H, data };
}

describe('hashes', () => {
  it('hash to 16 hex digits, identical images to the same value', () => {
    const img = stripes();
    expect(pHash(img)).toMatch(/^[0-9a-f]{16}$/);
    expect(dHash(img)).toMatch(/^[0-9a-f]{16}$/);
    expect(pHash(img)).toBe(pHash({ ...img, data: Uint8Array.from(img.data) }));
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000', '0000')).toBe(0);
    expect(hammingDistance('000f', '0000')).toBe(4);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(() => hammingDistance('00', '000')).toThrow(RangeError);
  });

  it('hashes every flat frame, any shade and with compression noise, like the flat reference', () => {
    expect(pHash(flat(255))).toBe(flatFrameHash());
    expect(pHash(flat(30, 2))).toBe(flatFrameHash());
    expect(hammingDistance(pHash(flat(0)), flatFrameHash())).toBeLessThanOrEqual(1); // DC bit only
  });

  it('is stable under a resize but not under a content change', () => {
    const img = stripes();
    const half = resizeGrey(img, W / 2, H / 2);
    expect(hammingDistance(pHash(img), pHash(half))).toBeLessThanOrEqual(2);
    expect(hammingDistance(pHash(img), pHash(withBox(img, 0.1, 0.4, 0.9, 0.6, 255)))).toBeGreaterThan(4);
  });
});

describe('resizeGrey / cropRows', () => {
  it('averages areas, so a thin line survives as a faint mark', () => {
    const img = withBox(flat(255), 0, 0.5, 1, 0.505, 0); // a one-pixel line
    const small = resizeGrey(img, 10, 20);
    expect(Math.min(...small.data)).toBeLessThan(255);
    expect(Math.min(...small.data)).toBeGreaterThan(0);
  });

  it('crops rows by fraction and refuses to crop to a sliver', () => {
    expect(cropRows(flat(1), 0.1, 0.9).height).toBe(Math.floor(H * 0.9) - Math.floor(H * 0.1));
    expect(cropRows(flat(1), 0.5, 0.51).height).toBe(H);
  });
});

describe('compareImages', () => {
  it('reports identical screenshots as the same', () => {
    const r = compareImages(stripes(), stripes());
    expect(r).toMatchObject({ phashDistance: 0, dhashDistance: 0, pixelChangeRatio: 0, same: true, sizeMismatch: false });
  });

  it('reports a changed region and the share of pixels it covers', () => {
    const base = withBox(flat(250), 0.1, 0.45, 0.9, 0.55);
    const changed = withBox(flat(250), 0.2, 0.45, 0.8, 0.55);
    const r = compareImages(base, changed);
    expect(r.same).toBe(false);
    expect(r.pixelChangeRatio).toBeGreaterThan(0.01);
    expect(r.pixelChangeRatio).toBeLessThan(0.03);
  });

  it('compares images of different sizes after scaling, and flags a different aspect', () => {
    const img = stripes();
    expect(compareImages(img, resizeGrey(img, W * 2, H * 2)).same).toBe(true);
    expect(compareImages(img, resizeGrey(img, W, H / 2)).sizeMismatch).toBe(true);
  });

  it('pixelChangeRatio honours the threshold', () => {
    expect(pixelChangeRatio(flat(100), flat(110))).toBe(0);
    expect(pixelChangeRatio(flat(100), flat(110), 5)).toBe(1);
  });
});

describe('analyzeBlank', () => {
  it('calls a flat frame blank, white or black, noisy or not', () => {
    for (const img of [flat(255), flat(0), flat(242, 3)]) {
      const r = analyzeBlank(img);
      expect(r.blank).toBe(true);
      expect(r.blankScore).toBe(1);
      expect(r.phashDistance).toBeLessThanOrEqual(10);
    }
  });

  it('ignores the status and navigation bars', () => {
    const chrome = withBox(withBox(flat(255), 0.05, 0.01, 0.3, 0.04), 0.3, 0.97, 0.7, 0.98);
    expect(analyzeBlank(chrome).blank).toBe(true);
  });

  it('does not call a sparse "Hello World" page blank', () => {
    // About 2 % of the area as dark text in the middle, like the template app.
    const hello = withBox(flat(255), 0.11, 0.47, 0.89, 0.5);
    const r = analyzeBlank(hello);
    expect(r.blank).toBe(false);
    expect(r.blankScore).toBeLessThan(0.99);
    expect(r.background).toBe(255);
  });

  it('does not call a page of full-width bands blank, though its pHash is near flat', () => {
    const r = analyzeBlank(stripes());
    expect(r.phashDistance).toBeLessThanOrEqual(10); // a one-directional pattern has a sparse DCT
    expect(r.stdDev).toBeGreaterThan(50);
    expect(r.blank).toBe(false);
  });

  it('calls a faint gradient with nothing on it blank', () => {
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) data.fill(240 + Math.floor((y / H) * 15), y * W, (y + 1) * W);
    const r = analyzeBlank({ width: W, height: H, data });
    expect(r.blank).toBe(true);
  });
});
