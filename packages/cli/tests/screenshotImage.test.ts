import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  buildGridSvg,
  renderWithGrid,
  buildContactSheet,
  frameDiffs,
  parseCropRect,
  padCropRect,
  cropImage,
} from '../src/lib/screenshotImage.js';

// sharp's first SVG composite pays a librsvg/native cold-start that can exceed
// vitest's 5s default on slow CI runners (observed flaky on windows-latest).
// Give the image tests headroom so the cold start doesn't time them out.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const solidJpeg = (w: number, h: number, r: number, g: number, b: number): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();

describe('buildGridSvg', () => {
  it('emits an SVG of the given size with 0.0-1.0 labels and axis markers', () => {
    const svg = buildGridSvg(800, 1200);
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="1200"');
    expect(svg).toContain('>0.0<');
    expect(svg).toContain('>1.0<');
    expect(svg).toContain('X →');
    expect(svg).toContain('Y ↓');
    // 9 interior vertical + 9 interior horizontal lines (the 0 and 10 edges are skipped).
    expect(svg.match(/<line/g)?.length).toBe(18);
  });
});

describe('renderWithGrid', () => {
  it('downscales to maxDim (longest side) and overlays the grid', async () => {
    const src = await solidJpeg(2000, 1000, 10, 20, 30);
    const out = await renderWithGrid(src, { maxDim: 1024, grid: true });
    expect(out.width).toBe(1024);
    expect(out.height).toBe(512);
    expect(out.originalWidth).toBe(2000);
    expect(out.originalHeight).toBe(1000);
    const meta = await sharp(out.buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(512);
  });

  it('downscales without a grid when grid is false', async () => {
    const src = await solidJpeg(1024, 512, 0, 0, 0);
    const out = await renderWithGrid(src, { maxDim: 256, grid: false });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(256);
  });

  it('never upscales when maxDim exceeds the source', async () => {
    const src = await solidJpeg(300, 200, 0, 0, 0);
    const out = await renderWithGrid(src, { maxDim: 1024, grid: true });
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
  });
});

describe('buildContactSheet', () => {
  it('tiles N frames into ceil(sqrt(N)) columns with the expected canvas size', async () => {
    const frames = await Promise.all(Array.from({ length: 8 }, () => solidJpeg(400, 800, 40, 40, 40)));
    const sheet = await buildContactSheet(frames, { maxDim: 512, gap: 8 });
    expect(sheet.count).toBe(8);
    expect(sheet.cols).toBe(3);
    expect(sheet.rows).toBe(3);
    expect(sheet.width).toBe(sheet.cols * sheet.tileWidth + (sheet.cols + 1) * 8);
    expect(sheet.height).toBe(sheet.rows * sheet.tileHeight + (sheet.rows + 1) * 8);
    const meta = await sharp(sheet.buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(sheet.width);
    expect(meta.height).toBe(sheet.height);
  });

  it('throws on an empty frame set', async () => {
    await expect(buildContactSheet([], { maxDim: 512 })).rejects.toThrow(/no frames/);
  });
});

describe('frameDiffs', () => {
  it('reports 0 for identical frames and ~1 for black->white', async () => {
    const black = await solidJpeg(64, 64, 0, 0, 0);
    const white = await solidJpeg(64, 64, 255, 255, 255);

    const same = await frameDiffs([black, black, black]);
    expect(same).toHaveLength(3);
    expect(same[0]).toBe(0);
    expect(same[1]).toBeLessThan(0.01);
    expect(same[2]).toBeLessThan(0.01);

    const diverge = await frameDiffs([black, white]);
    expect(diverge[0]).toBe(0);
    expect(diverge[1]).toBeGreaterThan(0.9);
  });

  it('returns an empty array for no frames', async () => {
    expect(await frameDiffs([])).toEqual([]);
  });
});

describe('parseCropRect', () => {
  it('parses four 0-1 fractions', () => {
    expect(parseCropRect('0.1, 0.2,0.9,1')).toEqual([0.1, 0.2, 0.9, 1]);
  });

  it('rejects malformed, out-of-range, and empty regions', () => {
    expect(() => parseCropRect('0.1,0.2,0.9')).toThrow(/four 0-1 fractions/);
    expect(() => parseCropRect('0,0,1.5,1')).toThrow(/four 0-1 fractions/);
    expect(() => parseCropRect('a,0,1,1')).toThrow(/four 0-1 fractions/);
    expect(() => parseCropRect('0.5,0,0.5,1')).toThrow(/x1 < x2/);
    expect(() => parseCropRect('0,0.8,1,0.2')).toThrow(/y1 < y2/);
  });
});

describe('padCropRect', () => {
  it('grows the rect on every side, clamped to 0-1', () => {
    const [x1, y1, x2, y2] = padCropRect([0.01, 0.5, 0.6, 0.99], 0.02);
    expect(x1).toBe(0);
    expect(y1).toBeCloseTo(0.48);
    expect(x2).toBeCloseTo(0.62);
    expect(y2).toBe(1);
  });
});

describe('cropImage', () => {
  it('crops at full resolution when the region fits within maxDim', async () => {
    const src = await solidJpeg(1000, 2000, 50, 60, 70);
    const out = await cropImage(src, [0.1, 0.1, 0.5, 0.3], { maxDim: 1024 });
    expect(out).toMatchObject({ left: 100, top: 200, cropWidth: 400, cropHeight: 400, width: 400, height: 400 });
    const meta = await sharp(out.buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([400, 400]);
  });

  it('downscales a large region to maxDim on its longest side', async () => {
    const src = await solidJpeg(1000, 2000, 0, 0, 0);
    const out = await cropImage(src, [0, 0, 1, 0.5], { maxDim: 256 });
    expect(out.cropWidth).toBe(1000);
    expect(out.cropHeight).toBe(1000);
    expect([out.width, out.height]).toEqual([256, 256]);
  });
});
