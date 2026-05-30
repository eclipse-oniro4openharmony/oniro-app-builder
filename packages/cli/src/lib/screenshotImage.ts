import sharp from 'sharp';

/**
 * Agent-facing screenshot image processing for the CLI.
 *
 * `@oniroproject/core` deliberately ships no image dependency — it returns raw
 * JPEG buffers. The grid overlay / downscale and the burst contact-sheet live
 * here (the CLI is the affordance layer), so `oniro-app screenshot` can produce
 * exactly what the ohos-hdc MCP used to. The grid drawing is ported verbatim
 * from that MCP so the output is equivalent.
 */

export interface RenderResult {
  /** Encoded JPEG. */
  buf: Buffer;
  /** Rendered (post-downscale) dimensions. */
  width: number;
  height: number;
  /** Source dimensions, before downscale. */
  originalWidth: number;
  originalHeight: number;
}

export interface RenderWithGridOptions {
  /** Longest-side cap in pixels. The image is downscaled (never upscaled) to fit. */
  maxDim: number;
  /** Overlay the 10x10 grid with 0.0–1.0 axis labels after downscaling. */
  grid?: boolean;
}

/**
 * Build an SVG overlay: a 10x10 grid with X/Y axis labels (0.0–1.0) sized to the
 * given image dimensions. Ported verbatim from the ohos-hdc MCP so the gridded
 * output matches what agents are used to.
 */
export function buildGridSvg(width: number, height: number): string {
  const lineColor = 'rgba(255,80,80,0.55)';
  const labelBg = 'rgba(0,0,0,0.7)';
  const labelFg = '#fff';
  const fontSize = Math.max(10, Math.round(Math.min(width, height) / 60));
  const padding = Math.round(fontSize * 0.4);
  const labels: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const f = i / 10;
    const x = Math.round(f * (width - 1));
    const y = Math.round(f * (height - 1));
    // grid lines (skip 0 and 10 — those are the image edges)
    if (i > 0 && i < 10) {
      lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${lineColor}" stroke-width="1"/>`);
      lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${lineColor}" stroke-width="1"/>`);
    }
    const tag = f.toFixed(1);
    // X-axis labels along the top
    const tx = i === 0 ? padding : i === 10 ? width - padding : x;
    const anchorX = i === 0 ? 'start' : i === 10 ? 'end' : 'middle';
    labels.push(
      `<text x="${tx}" y="${fontSize + padding}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="${labelFg}" stroke="${labelBg}" stroke-width="3" paint-order="stroke" text-anchor="${anchorX}">${tag}</text>`,
    );
    // Y-axis labels along the left
    const ty = i === 0 ? fontSize + padding : i === 10 ? height - padding : y + fontSize / 3;
    labels.push(
      `<text x="${padding}" y="${ty}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="${labelFg}" stroke="${labelBg}" stroke-width="3" paint-order="stroke" text-anchor="start">${tag}</text>`,
    );
  }
  // Axis title markers in the corners
  labels.push(
    `<text x="${width / 2}" y="${fontSize * 2.4 + padding}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="${labelFg}" stroke="${labelBg}" stroke-width="3" paint-order="stroke" text-anchor="middle">X →</text>`,
  );
  labels.push(
    `<text x="${padding}" y="${fontSize * 2.6 + padding}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="${labelFg}" stroke="${labelBg}" stroke-width="3" paint-order="stroke" text-anchor="start">Y ↓</text>`,
  );
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${lines.join('')}${labels.join('')}</svg>`;
}

/**
 * Downscale a JPEG so its longest side is <= `maxDim` (never upscaling) and,
 * when `grid` is set, overlay the coordinate grid. Returns the encoded JPEG plus
 * rendered and original dimensions.
 */
export async function renderWithGrid(jpeg: Buffer, opts: RenderWithGridOptions): Promise<RenderResult> {
  const meta = await sharp(jpeg).metadata();
  const originalWidth = meta.width ?? 0;
  const originalHeight = meta.height ?? 0;
  const longest = Math.max(originalWidth, originalHeight) || 1;
  const scale = Math.min(1, opts.maxDim / longest);
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const resized = await sharp(jpeg).resize(width, height).jpeg({ quality: 80 }).toBuffer();
  if (!opts.grid) {
    return { buf: resized, width, height, originalWidth, originalHeight };
  }
  const svg = buildGridSvg(width, height);
  const buf = await sharp(resized)
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 80 })
    .toBuffer();
  return { buf, width, height, originalWidth, originalHeight };
}

export interface ContactSheetOptions {
  /** Longest-side cap for the whole sheet; per-tile size derives from this. */
  maxDim: number;
  /** Tiles per row. Defaults to ceil(sqrt(N)). */
  cols?: number;
  /** Per-frame diff (0..1), index-aligned with `frames`; printed on each tile. */
  diffs?: number[];
  /** Gap between tiles, px. */
  gap?: number;
}

export interface ContactSheetResult {
  buf: Buffer;
  width: number;
  height: number;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  count: number;
}

function buildTileLabelSvg(width: number, height: number, idx: number, diff?: number): string {
  const fontSize = Math.max(12, Math.round(Math.min(width, height) / 16));
  const pad = Math.round(fontSize * 0.4);
  let label = `#${idx}`;
  if (typeof diff === 'number') label += `  Δ${diff.toFixed(2)}`;
  const boxW = Math.round(label.length * fontSize * 0.62) + pad * 2;
  const boxH = fontSize + pad * 2;
  return (
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.6)"/>` +
    `<text x="${pad}" y="${fontSize + pad - 1}" font-family="monospace" font-size="${fontSize}" font-weight="bold" fill="#fff" stroke="rgba(0,0,0,0.85)" stroke-width="3" paint-order="stroke" text-anchor="start">${label}</text>` +
    `</svg>`
  );
}

/**
 * Composite a burst of JPEG frames into a single tiled contact sheet, each tile
 * labelled with its frame index (and per-frame diff when provided). One image
 * replaces N — a large token saving when verifying transient UI.
 */
export async function buildContactSheet(frames: Buffer[], opts: ContactSheetOptions): Promise<ContactSheetResult> {
  if (frames.length === 0) throw new Error('buildContactSheet: no frames');
  const count = frames.length;
  const cols = Math.max(1, opts.cols ?? Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const gap = opts.gap ?? 8;

  const meta0 = await sharp(frames[0]).metadata();
  const fw = meta0.width ?? 1;
  const fh = meta0.height ?? 1;
  const longest = Math.max(fw, fh) || 1;
  const tileScale = Math.min(1, opts.maxDim / cols / longest);
  const tileWidth = Math.max(1, Math.round(fw * tileScale));
  const tileHeight = Math.max(1, Math.round(fh * tileScale));

  const tiles = await Promise.all(
    frames.map((frame, i) => {
      const label = Buffer.from(buildTileLabelSvg(tileWidth, tileHeight, i, opts.diffs?.[i]));
      return sharp(frame)
        .resize(tileWidth, tileHeight, { fit: 'fill' })
        .composite([{ input: label, top: 0, left: 0 }])
        .png()
        .toBuffer();
    }),
  );

  const width = cols * tileWidth + (cols + 1) * gap;
  const height = rows * tileHeight + (rows + 1) * gap;
  const placements = tiles.map((input, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return { input, left: gap + c * (tileWidth + gap), top: gap + r * (tileHeight + gap) };
  });

  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .composite(placements)
    .jpeg({ quality: 80 })
    .toBuffer();

  return { buf, width, height, cols, rows, tileWidth, tileHeight, count };
}

/**
 * Per-frame change metric: mean absolute difference of a downscaled greyscale
 * thumbnail vs. the previous frame, normalised to 0..1. Frame 0 is 0 (no
 * predecessor). Cheap, deterministic, and device-free.
 */
export async function frameDiffs(frames: Buffer[], opts: { sample?: number } = {}): Promise<number[]> {
  if (frames.length === 0) return [];
  const sample = opts.sample ?? 32;
  const thumbs = await Promise.all(
    frames.map((f) => sharp(f).greyscale().resize(sample, sample, { fit: 'fill' }).raw().toBuffer()),
  );
  const out: number[] = [0];
  for (let i = 1; i < thumbs.length; i++) {
    const a = thumbs[i - 1];
    const b = thumbs[i];
    if (!a || !b) {
      out.push(0);
      continue;
    }
    const n = Math.min(a.length, b.length) || 1;
    let s = 0;
    for (let k = 0; k < n; k++) s += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
    out.push(+(s / n / 255).toFixed(4));
  }
  return out;
}
