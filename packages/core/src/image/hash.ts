/*
 * Perceptual hashes, image comparison and blank-screen detection over decoded
 * greyscale pixels.
 *
 * The blank-screen check follows the pattern of deveco-cli's smoke inspector
 * (openharmony-sig/deveco-cli, packages/cli/src/smoke/screen-phash.ts,
 * Copyright (c) 2026 Huawei Device Co., Ltd., MIT License): a DCT pHash of the
 * app area — the status bar and navigation bar cropped off — compared by
 * Hamming distance with the hash of a flat frame, a distance of 10 or less
 * meaning blank. This file is a reimplementation, not a copy: it works on
 * greyscale input decoded elsewhere (the CLI uses sharp; core decodes no
 * images), uses an orthonormal DCT with a noise floor in grey levels, and adds
 * a dHash, a pixel-change ratio, a background-share measure, and a variance
 * condition on the hash verdict (a one-directional pattern hashes near flat).
 * See NOTICE.
 */

/** A decoded 8-bit greyscale image, row-major, one byte per pixel. */
export interface GreyImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Bits in a {@link pHash} / {@link dHash}. */
export const HASH_BITS = 64;

/** A frame whose pHash is this close to a flat frame's is blank (deveco-cli's threshold)… */
export const BLANK_PHASH_DISTANCE = 10;
/**
 * …provided its grey levels barely vary. A pattern that varies in one
 * direction only (full-width bands) also has a sparse DCT and hashes close to
 * flat, so the hash alone is not enough.
 */
export const BLANK_MAX_STDDEV = 10;

/**
 * A frame where at least this share of the app area is the background colour
 * is blank, whatever its hash says. A "Hello World" page leaves about 1 % of
 * the area as ink, so the bar sits well above it.
 */
export const BLANK_BACKGROUND_SHARE = 0.998;

// Share of the frame cropped off as system chrome before the blank check.
const CROP_TOP = 0.06;
const CROP_BOTTOM = 0.04;

// pHash: DCT of a 32x32 thumbnail, the 8x8 low-frequency block kept.
const PHASH_SAMPLE = 32;
const PHASH_LOW = 8;
// Orthonormal DCT coefficients below this (in grey levels) are noise, not content.
const PHASH_NOISE_FLOOR = 1;

// A pixel differs when its grey level moved by more than this (0-255).
const CHANGE_THRESHOLD = 24;
// Comparison resolution: the longer side of the thumbnail both images are reduced to.
const COMPARE_SIZE = 256;

function assertImage(img: GreyImage): void {
  if (img.width < 1 || img.height < 1 || img.data.length < img.width * img.height) {
    throw new RangeError(`Bad greyscale image ${img.width}x${img.height} (${img.data.length} bytes).`);
  }
}

/**
 * Resample to `width`x`height` by area averaging (each output pixel is the
 * mean of the source pixels it covers), which keeps thin features such as text
 * as a faint mark instead of dropping them.
 */
export function resizeGrey(img: GreyImage, width: number, height: number): GreyImage {
  assertImage(img);
  if (img.width === width && img.height === height) return img;
  const out = new Uint8Array(width * height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let sum = 0;
      let weight = 0;
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        const row = yy * img.width;
        for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          sum += img.data[row + xx]! * wx * wy;
          weight += wx * wy;
        }
      }
      out[y * width + x] = Math.round(weight > 0 ? sum / weight : 0);
    }
  }
  return { width, height, data: out };
}

/** The rows from `top` to `bottom` (fractions 0-1 of the height). */
export function cropRows(img: GreyImage, top: number, bottom: number): GreyImage {
  assertImage(img);
  const y0 = Math.max(0, Math.floor(img.height * top));
  const y1 = Math.min(img.height, Math.floor(img.height * bottom));
  if (y1 - y0 < 8) return img;
  return { width: img.width, height: y1 - y0, data: img.data.subarray(y0 * img.width, y1 * img.width) };
}

function bitsToHex(bits: readonly boolean[]): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) nibble = (nibble << 1) | (bits[i + j] ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/** Hamming distance between two equal-length hex hashes (0 = identical, 64 = every bit differs). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new RangeError(`Hash lengths differ (${a.length} vs ${b.length}).`);
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

let cosTable: Float64Array | null = null;

/** Orthonormal 2-D DCT-II of an NxN block (N = PHASH_SAMPLE). */
function dct2(block: Float64Array, n: number): Float64Array {
  if (!cosTable) {
    cosTable = new Float64Array(n * n);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) cosTable[k * n + i] = Math.cos((Math.PI * (i + 0.5) * k) / n);
    }
  }
  const scale = (k: number): number => (k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));
  const rows = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += block[y * n + i]! * cosTable[k * n + i]!;
      rows[y * n + k] = s * scale(k);
    }
  }
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rows[i * n + x]! * cosTable[k * n + i]!;
      out[k * n + x] = s * scale(k);
    }
  }
  return out;
}

/**
 * 64-bit DCT perceptual hash as 16 hex digits: the image reduced to 32x32, its
 * orthonormal DCT, the 8x8 lowest frequencies compared with their median (the
 * DC term left out of the median). Coefficients under one grey level count as
 * zero, so a flat frame with compression noise still hashes as flat.
 */
export function pHash(img: GreyImage): string {
  const small = resizeGrey(img, PHASH_SAMPLE, PHASH_SAMPLE);
  const block = Float64Array.from(small.data);
  const dct = dct2(block, PHASH_SAMPLE);
  const low: number[] = [];
  for (let y = 0; y < PHASH_LOW; y++) {
    for (let x = 0; x < PHASH_LOW; x++) {
      const v = dct[y * PHASH_SAMPLE + x]!;
      low.push(Math.abs(v) < PHASH_NOISE_FLOOR ? 0 : v);
    }
  }
  const ac = low.slice(1).sort((p, q) => p - q);
  const median = (ac[(ac.length - 1) >> 1]! + ac[ac.length >> 1]!) / 2;
  return bitsToHex(low.map((v) => v > median));
}

/**
 * 64-bit difference hash as 16 hex digits: the image reduced to 9x8, one bit
 * per horizontally adjacent pair (left brighter than right). Cheaper than the
 * pHash and more sensitive to small shifts.
 */
export function dHash(img: GreyImage): string {
  const small = resizeGrey(img, 9, 8);
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits.push(small.data[y * 9 + x]! > small.data[y * 9 + x + 1]!);
  }
  return bitsToHex(bits);
}

let flatHash: string | null = null;

/** pHash of a flat (single-colour) frame; every flat frame hashes the same. */
export function flatFrameHash(): string {
  return (flatHash ??= pHash({ width: 8, height: 8, data: new Uint8Array(64).fill(128) }));
}

/** Reduce both images to the same thumbnail (aspect of `a`, longer side {@link COMPARE_SIZE}). */
function commonThumbnails(a: GreyImage, b: GreyImage): [GreyImage, GreyImage] {
  const scale = COMPARE_SIZE / Math.max(a.width, a.height);
  const w = Math.max(1, Math.min(a.width, Math.round(a.width * scale)));
  const h = Math.max(1, Math.min(a.height, Math.round(a.height * scale)));
  return [resizeGrey(a, w, h), resizeGrey(b, w, h)];
}

/**
 * Share (0-1) of pixels whose grey level moved by more than `threshold`
 * (default 24 of 255), with both images reduced to a common thumbnail.
 */
export function pixelChangeRatio(a: GreyImage, b: GreyImage, threshold = CHANGE_THRESHOLD): number {
  const [ta, tb] = commonThumbnails(a, b);
  let changed = 0;
  for (let i = 0; i < ta.data.length; i++) if (Math.abs(ta.data[i]! - tb.data[i]!) > threshold) changed++;
  return changed / ta.data.length;
}

export interface ImageComparison {
  /** pHash Hamming distance, 0-64 (0 = perceptually identical). */
  phashDistance: number;
  /** dHash Hamming distance, 0-64. */
  dhashDistance: number;
  /** Share (0-1) of pixels that changed by more than 24 grey levels. */
  pixelChangeRatio: number;
  /** The two images have different dimensions (compared after scaling to a common size). */
  sizeMismatch: boolean;
  /** Both hashes within 4 bits and under 1 % of pixels changed. */
  same: boolean;
}

/** Thresholds behind {@link ImageComparison.same}. */
export const SAME_MAX_HASH_DISTANCE = 4;
export const SAME_MAX_CHANGE_RATIO = 0.01;

/** Compare two screenshots: perceptual-hash distances plus the share of pixels that changed. */
export function compareImages(baseline: GreyImage, current: GreyImage): ImageComparison {
  assertImage(baseline);
  assertImage(current);
  const phashDistance = hammingDistance(pHash(baseline), pHash(current));
  const dhashDistance = hammingDistance(dHash(baseline), dHash(current));
  const ratio = pixelChangeRatio(baseline, current);
  return {
    phashDistance,
    dhashDistance,
    pixelChangeRatio: +ratio.toFixed(4),
    sizeMismatch:
      Math.abs(baseline.width / baseline.height - current.width / current.height) > 0.01,
    same:
      phashDistance <= SAME_MAX_HASH_DISTANCE &&
      dhashDistance <= SAME_MAX_HASH_DISTANCE &&
      ratio < SAME_MAX_CHANGE_RATIO,
  };
}

export interface BlankAnalysis {
  /** The app area shows nothing: flat by pHash with little variance, or almost all one colour. */
  blank: boolean;
  /** Share (0-1) of the app area within 24 grey levels of its dominant colour; 1 = a flat frame. */
  blankScore: number;
  /** pHash Hamming distance from a flat frame (0-64); at most 10 is blank. */
  phashDistance: number;
  /** Standard deviation of the app area's grey levels (0 = flat). */
  stdDev: number;
  /** The dominant grey level (0-255) of the app area. */
  background: number;
}

/**
 * Whether a screenshot shows a blank app: the status and navigation bars are
 * cropped off (top 6 %, bottom 4 %), then the frame is blank when its pHash is
 * within {@link BLANK_PHASH_DISTANCE} bits of a flat frame's and its standard
 * deviation is at most {@link BLANK_MAX_STDDEV}, or when at least
 * {@link BLANK_BACKGROUND_SHARE} of it is the dominant colour.
 */
export function analyzeBlank(img: GreyImage): BlankAnalysis {
  const area = cropRows(img, CROP_TOP, 1 - CROP_BOTTOM);
  const phashDistance = hammingDistance(pHash(area), flatFrameHash());

  const scale = COMPARE_SIZE / Math.max(area.width, area.height);
  const thumb = resizeGrey(
    area,
    Math.max(1, Math.min(area.width, Math.round(area.width * scale))),
    Math.max(1, Math.min(area.height, Math.round(area.height * scale))),
  );
  const hist = new Uint32Array(256);
  let sum = 0;
  for (const v of thumb.data) {
    hist[v]!++;
    sum += v;
  }
  const n = thumb.data.length;
  const mean = sum / n;
  let sq = 0;
  for (const v of thumb.data) sq += (v - mean) ** 2;
  let background = 0;
  for (let v = 1; v < 256; v++) if (hist[v]! > hist[background]!) background = v;
  let near = 0;
  for (let v = Math.max(0, background - CHANGE_THRESHOLD); v <= Math.min(255, background + CHANGE_THRESHOLD); v++) {
    near += hist[v]!;
  }
  const blankScore = near / n;
  const stdDev = Math.sqrt(sq / n);
  return {
    blank:
      (phashDistance <= BLANK_PHASH_DISTANCE && stdDev <= BLANK_MAX_STDDEV) || blankScore >= BLANK_BACKGROUND_SHARE,
    blankScore: +blankScore.toFixed(4),
    phashDistance,
    stdDev: +stdDev.toFixed(2),
    background,
  };
}
