/**
 * Section / profile analysis: sample a cylindrical tube around a segment and
 * reduce the samples to a 1-D curve along the section.
 */

import type { CloudView } from './cloud';

export interface ProfileOptions {
  /** Tube radius around the section line, in world units. */
  radius: number;
  /** Number of bins along the section. */
  bins: number;
  /** 'x' | 'y' | 'z' or a scalar attribute name. */
  field: string;
  /** Moving-average window in bins (0 disables). */
  smooth: number;
  /** Cap on raw samples kept for the scatter overlay. */
  maxRaw: number;
}

export interface ProfileStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  std: number;
  start: number;
  end: number;
  delta: number;
  /** Largest |Δvalue| between consecutive bins. */
  maxSlope: number;
  /** Distance from A where the extremes occur. */
  minAt: number;
  maxAt: number;
  /** Least-squares slope in value per world unit. */
  trend: number;
}

export interface ProfileResult {
  /** Bin centre distance from A. */
  t: Float32Array;
  /** Mean value per bin (NaN when empty). */
  v: Float32Array;
  /** Std-dev per bin. */
  sd: Float32Array;
  /** Number of contributing points per bin. */
  n: Int32Array;
  /** Raw (decimated) samples for the scatter overlay. */
  rawT: Float32Array;
  rawV: Float32Array;
  length: number;
  sampled: number;
  field: string;
  stats: ProfileStats;
}

export const PROFILE_DEFAULTS: ProfileOptions = {
  radius: 0,
  bins: 120,
  field: '',
  smooth: 0,
  maxRaw: 6000,
};

export function sampleProfile(
  view: CloudView,
  a: [number, number, number],
  b: [number, number, number],
  opts: ProfileOptions
): ProfileResult | null {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const bins = Math.max(2, Math.floor(opts.bins));
  const t = new Float32Array(bins);
  const v = new Float32Array(bins).fill(NaN);
  const sd = new Float32Array(bins).fill(NaN);
  const n = new Int32Array(bins);
  for (let i = 0; i < bins; i++) t[i] = ((i + 0.5) / bins) * length;

  if (!(length > 0)) {
    return {
      t, v, sd, n, rawT: new Float32Array(0), rawV: new Float32Array(0),
      length: 0, sampled: 0, field: opts.field,
      stats: emptyStats(),
    };
  }

  const radius = opts.radius > 0 ? opts.radius : autoRadius(view, length);
  const pos = view.positions;
  const { indices, t: rawDist, n: sampled } = view.index.alongSegment(
    pos, a[0], a[1], a[2], b[0], b[1], b[2], radius
  );

  const field = opts.field;
  let values: Float32Array | null = null;
  let axis = -1;
  if (field === 'x' || field === 'y' || field === 'z') {
    axis = field === 'x' ? 0 : field === 'y' ? 1 : 2;
  } else if (field) {
    values = view.values(field);
  } else {
    axis = 2; // default: elevation profile
  }

  const sum = new Float64Array(bins);
  const sumSq = new Float64Array(bins);

  const rawStride = Math.max(1, Math.ceil(sampled / opts.maxRaw));
  const rawCap = Math.ceil(sampled / rawStride);
  const rawT = new Float32Array(rawCap);
  const rawV = new Float32Array(rawCap);
  let rawK = 0;

  for (let k = 0; k < sampled; k++) {
    const pi = indices[k];
    const val = axis >= 0 ? pos[pi * 3 + axis] : values ? values[pi] : NaN;
    if (!Number.isFinite(val)) continue;
    const d = rawDist[k];
    let bi = Math.floor((d / length) * bins);
    if (bi < 0) bi = 0;
    else if (bi >= bins) bi = bins - 1;
    sum[bi] += val;
    sumSq[bi] += val * val;
    n[bi]++;
    if (k % rawStride === 0 && rawK < rawCap) {
      rawT[rawK] = d;
      rawV[rawK] = val;
      rawK++;
    }
  }

  for (let i = 0; i < bins; i++) {
    if (n[i] === 0) continue;
    const mean = sum[i] / n[i];
    v[i] = mean;
    sd[i] = Math.sqrt(Math.max(0, sumSq[i] / n[i] - mean * mean));
  }

  fillGaps(v);
  fillGaps(sd);
  if (opts.smooth > 1) {
    smoothInPlace(v, opts.smooth);
    smoothInPlace(sd, opts.smooth);
  }

  return {
    t, v, sd, n,
    rawT: rawT.subarray(0, rawK),
    rawV: rawV.subarray(0, rawK),
    length, sampled, field,
    stats: computeProfileStats(t, v),
  };
}

/** Linearly interpolate across empty bins. */
function fillGaps(arr: Float32Array): void {
  const len = arr.length;
  let i = 0;
  while (i < len && Number.isFinite(arr[i])) i++;
  if (i === len) return;
  let j = i;
  while (j < len && !Number.isFinite(arr[j])) j++;
  if (j === len) {
    const fillv = i > 0 ? arr[i - 1] : 0;
    for (let k = i; k < len; k++) arr[k] = fillv;
    return;
  }
  const a = i > 0 ? arr[i - 1] : arr[j];
  const b = arr[j];
  for (let k = i; k < j; k++) arr[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  // Recurse for remaining gaps.
  const rest = arr.subarray(j);
  fillGaps(rest);
}

function smoothInPlace(arr: Float32Array, win: number): void {
  const len = arr.length;
  const half = Math.floor(win / 2);
  const src = arr.slice();
  for (let i = 0; i < len; i++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(len - 1, i + half); k++) {
      const val = src[k];
      if (Number.isFinite(val)) { s += val; c++; }
    }
    if (c) arr[i] = s / c;
  }
}

function computeProfileStats(t: Float32Array, v: Float32Array): ProfileStats {
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, count = 0;
  let minAt = 0, maxAt = 0;
  let maxSlope = 0;
  let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    const val = v[i];
    if (!Number.isFinite(val)) continue;
    if (val < min) { min = val; minAt = t[i]; }
    if (val > max) { max = val; maxAt = t[i]; }
    sum += val;
    sumSq += val * val;
    count++;
    if (Number.isFinite(prev)) {
      const dt = t[i] - t[i - 1];
      if (dt > 0) maxSlope = Math.max(maxSlope, Math.abs(val - prev) / dt);
    }
    prev = val;
  }
  if (count === 0) return emptyStats();
  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));

  // Least-squares slope.
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < v.length; i++) {
    const val = v[i];
    if (!Number.isFinite(val)) continue;
    sx += t[i]; sy += val; sxy += t[i] * val; sxx += t[i] * t[i];
  }
  const denom = count * sxx - sx * sx;

  const sorted = Float32Array.from(v).filter(Number.isFinite).sort();
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;

  return {
    min, max, mean, median, std,
    start: v[0], end: v[v.length - 1],
    delta: v[v.length - 1] - v[0],
    maxSlope,
    minAt, maxAt,
    trend: Math.abs(denom) < 1e-12 ? 0 : (count * sxy - sx * sy) / denom,
  };
}

/**
 * Default tube radius for a section line.
 *
 * A fixed fraction of the bounding box produces wildly different sample counts
 * depending on cloud density and world units, so we scale with the cloud's mean
 * point spacing instead: about two spacings wide captures a contiguous slice of
 * the surface without smearing across separate features. Clamped so it stays
 * sane both for very long sections and for tiny crops of huge clouds.
 */
function autoRadius(view: CloudView, length: number): number {
  const b = view.bounds;
  const sx = Math.max(b.max[0] - b.min[0], 1e-9);
  const sy = Math.max(b.max[1] - b.min[1], 1e-9);
  const sz = Math.max(b.max[2] - b.min[2], 1e-9);
  const spacing = Math.cbrt((sx * sy * sz) / Math.max(1, view.count));
  const lo = Math.max(spacing * 0.5, view.diagonal * 0.0005);
  const hi = Math.max(length * 0.02, view.diagonal * 0.005, lo);
  return Math.min(Math.max(spacing * 2, lo), hi);
}

function emptyStats(): ProfileStats {
  return {
    min: NaN, max: NaN, mean: NaN, median: NaN, std: NaN,
    start: NaN, end: NaN, delta: NaN, maxSlope: NaN,
    minAt: NaN, maxAt: NaN, trend: NaN,
  };
}

/** Export a profile as CSV text. */
export function profileToCSV(res: ProfileResult, unit = ''): string {
  const lines = ['distance,value,std,count'];
  for (let i = 0; i < res.t.length; i++) {
    lines.push(
      [
        res.t[i].toFixed(6),
        Number.isFinite(res.v[i]) ? res.v[i].toFixed(6) : '',
        Number.isFinite(res.sd[i]) ? res.sd[i].toFixed(6) : '',
        res.n[i],
      ].join(',')
    );
  }
  const head = [
    `# profile field: ${res.field || 'z'}${unit ? ` (${unit})` : ''}`,
    `# length: ${res.length}`,
    `# sampled points: ${res.sampled}`,
  ];
  return head.join('\n') + '\n' + lines.join('\n');
}
