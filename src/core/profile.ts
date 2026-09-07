/**
 * Section / profile analysis: lay out sample points along a measurement
 * segment and reduce the cloud around each of them to a single value.
 *
 * Sampling strategies (`ProfileMethod`)
 *   'idw'     — inverse-distance-weighted mean of every point within `radius`
 *               of the sample point. Local, stable and smooth: the default.
 *   'mean'    — plain arithmetic mean of the same neighbourhood.
 *   'nearest' — the value of the single closest point. Nothing is invented:
 *               voids stay empty (NaN) so both the curve and the export show
 *               where the line really had no data.
 */

import type { CloudView } from './cloud';

/** How one sample point along the section is reduced to a single value. */
export type ProfileMethod = 'idw' | 'mean' | 'nearest';

export interface ProfileOptions {
  /** Neighbourhood radius around each sample point, in world units (0 = auto). */
  radius: number;
  /** Number of sample points laid out along the section. */
  bins: number;
  /** 'x' | 'y' | 'z' or a scalar attribute name. */
  field: string;
  /** Moving-average window in samples (0 disables). */
  smooth: number;
  /** Cap on raw samples kept for the scatter overlay. */
  maxRaw: number;
  /** Reduction strategy — see `ProfileMethod`. */
  method: ProfileMethod;
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
  /** Largest |Δvalue| between consecutive samples. */
  maxSlope: number;
  /** Distance from A where the extremes occur. */
  minAt: number;
  maxAt: number;
  /** Least-squares slope in value per world unit. */
  trend: number;
}

export interface ProfileResult {
  /** Distance of each sample from A (0 … length, endpoints included). */
  t: Float32Array;
  /** Representative coordinates of each sample: the IDW/mean centroid, or the
   *  exact position of the nearest point (falls back to the nominal point on
   *  the line when nothing was found). */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Value per sample (NaN where nothing was found and nothing is filled in). */
  v: Float32Array;
  /** Dispersion per sample (weighted std-dev; NaN without neighbours). */
  sd: Float32Array;
  /** Number of contributing points per sample (1 for 'nearest'). */
  n: Int32Array;
  /** Raw (decimated) samples for the scatter overlay. */
  rawT: Float32Array;
  rawV: Float32Array;
  length: number;
  /** Points found inside the tube around the whole section. */
  sampled: number;
  field: string;
  method: ProfileMethod;
  /** Neighbourhood radius actually used (resolved from `autoRadius`). */
  radius: number;
  /** Endpoints, so an exported table is self-contained. */
  a: [number, number, number];
  b: [number, number, number];
  stats: ProfileStats;
}

export const PROFILE_DEFAULTS: ProfileOptions = {
  radius: 0,
  bins: 120,
  field: '',
  smooth: 0,
  maxRaw: 6000,
  method: 'idw',
};

/** Guard rail for the "sample count" control. */
const MAX_SAMPLES = 5000;

export function sampleProfile(
  view: CloudView,
  a: [number, number, number],
  b: [number, number, number],
  opts: ProfileOptions
): ProfileResult | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dy, dz);
  const method: ProfileMethod = opts.method ?? 'idw';

  const bins = Math.max(2, Math.min(MAX_SAMPLES, Math.floor(opts.bins) || 2));
  const t = new Float32Array(bins);
  const x = new Float32Array(bins);
  const y = new Float32Array(bins);
  const z = new Float32Array(bins);
  const v = new Float32Array(bins).fill(NaN);
  const sd = new Float32Array(bins).fill(NaN);
  const n = new Int32Array(bins);

  const span = bins > 1 ? bins - 1 : 1;
  const ux = length > 0 ? dx / length : 0;
  const uy = length > 0 ? dy / length : 0;
  const uz = length > 0 ? dz / length : 0;
  for (let i = 0; i < bins; i++) {
    const d = (i / span) * length;
    t[i] = d;
    x[i] = a[0] + ux * d;
    y[i] = a[1] + uy * d;
    z[i] = a[2] + uz * d;
  }

  const empty = (radius: number): ProfileResult => ({
    t, x, y, z, v, sd, n,
    rawT: new Float32Array(0),
    rawV: new Float32Array(0),
    length: 0,
    sampled: 0,
    field: opts.field,
    method,
    radius,
    a: [a[0], a[1], a[2]],
    b: [b[0], b[1], b[2]],
    stats: emptyStats(),
  });

  if (!(length > 0)) return empty(0);

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

  // Raw scatter overlay — one cheap decimated pass over everything in the tube.
  const rawStride = Math.max(1, Math.ceil(sampled / opts.maxRaw));
  const rawCap = Math.ceil(sampled / rawStride);
  const rawT = new Float32Array(rawCap);
  const rawV = new Float32Array(rawCap);
  let rawK = 0;
  for (let k = 0; k < sampled; k++) {
    const pi = indices[k];
    const val = axis >= 0 ? pos[pi * 3 + axis] : values ? values[pi] : NaN;
    if (!Number.isFinite(val)) continue;
    if (k % rawStride === 0 && rawK < rawCap) {
      rawT[rawK] = rawDist[k];
      rawV[rawK] = val;
      rawK++;
    }
  }

  if (sampled > 0) {
    reduceNeighbourhoods({
      positions: pos,
      indices,
      dist: rawDist,
      sampled,
      bins,
      length,
      radius,
      method,
      axis,
      values,
      out: { t, x, y, z, v, sd, n },
    });
  }

  if (method === 'nearest') {
    // Nothing to invent: a sample with no neighbour stays empty.
  } else {
    fillGaps(v);
    fillGaps(sd);
  }
  if (opts.smooth > 1) {
    smoothInPlace(v, opts.smooth);
    if (method !== 'nearest') smoothInPlace(sd, opts.smooth);
  }

  return {
    t, x, y, z, v, sd, n,
    rawT: rawT.subarray(0, rawK),
    rawV: rawV.subarray(0, rawK),
    length, sampled, field, method, radius,
    a: [a[0], a[1], a[2]],
    b: [b[0], b[1], b[2]],
    stats: computeProfileStats(t, v),
  };
}

/* ══════════════════════════════════════════════════════════════
   Neighbourhood reduction
   ══════════════════════════════════════════════════════════════ */

interface CandidateSet {
  positions: Float32Array;
  /** View indices of the points inside the tube. */
  indices: Uint32Array;
  /** Projected distance from A for each candidate. */
  dist: Float32Array;
  sampled: number;
}

interface ReduceJob extends CandidateSet {
  bins: number;
  length: number;
  radius: number;
  method: ProfileMethod;
  axis: number;
  values: Float32Array | null;
  out: {
    t: Float32Array;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    v: Float32Array;
    sd: Float32Array;
    n: Int32Array;
  };
}

/**
 * For every sample point, look at the neighbours within `radius` and reduce
 * them with the requested strategy.
 *
 * Candidates are bucketed by their projection onto the line (counting sort,
 * O(n)), so each sample only visits candidates whose along-line distance is
 * within ±radius — every true neighbour is guaranteed to be in there, because
 * |Δprojection| ≤ Euclidean distance.
 */
function reduceNeighbourhoods(job: ReduceJob): void {
  const { positions, indices, dist, sampled, bins, length, radius, method, axis, values, out } = job;
  const { t, x, y, z, v, sd, n } = out;

  // ── counting sort of the candidates by projection ──
  const nb = bins + 1;
  const bs = Math.max(length / Math.max(1, bins - 1), 1e-9);
  const start = new Int32Array(nb + 1);
  const bucketOf = new Int32Array(sampled);
  for (let k = 0; k < sampled; k++) {
    let bk = Math.floor(dist[k] / bs);
    if (bk < 0) bk = 0; else if (bk > nb - 1) bk = nb - 1;
    bucketOf[k] = bk;
    start[bk + 1]++;
  }
  for (let c = 0; c < nb; c++) start[c + 1] += start[c];
  const cursor = start.slice(0, nb);
  const order = new Uint32Array(sampled);
  for (let k = 0; k < sampled; k++) order[cursor[bucketOf[k]]++] = k;

  const r2 = radius * radius;
  // Softens the 1/d² singularity when a point sits exactly on the sample.
  const eps2 = Math.max(r2 * 1e-8, 1e-20);
  const nearest = method === 'nearest';

  for (let i = 0; i < bins; i++) {
    const px = x[i];
    const py = y[i];
    const pz = z[i];

    let b0 = Math.floor((t[i] - radius) / bs);
    let b1 = Math.floor((t[i] + radius) / bs);
    if (b0 < 0) b0 = 0; else if (b0 > nb - 1) b0 = nb - 1;
    if (b1 < 0) b1 = 0; else if (b1 > nb - 1) b1 = nb - 1;
    const kEnd = start[b1 + 1];

    let wSum = 0;
    let valSum = 0;
    let valSqSum = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let hits = 0;
    let bestD2 = Infinity;
    let bestVal = NaN;
    let bestXi = -1;

    for (let k = start[b0]; k < kEnd; k++) {
      const c = order[k];
      const pi = indices[c];
      const p3 = pi * 3;
      const ex = positions[p3] - px;
      const ey = positions[p3 + 1] - py;
      const ez = positions[p3 + 2] - pz;
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 > r2) continue;
      const val = axis >= 0 ? positions[p3 + axis] : values ? values[pi] : NaN;
      if (!Number.isFinite(val)) continue;

      if (nearest) {
        if (d2 < bestD2) {
          bestD2 = d2;
          bestVal = val;
          bestXi = pi;
        }
        continue;
      }

      const w = method === 'idw' ? 1 / (d2 + eps2) : 1;
      wSum += w;
      valSum += w * val;
      valSqSum += w * val * val;
      cx += w * positions[p3];
      cy += w * positions[p3 + 1];
      cz += w * positions[p3 + 2];
      hits++;
    }

    if (nearest) {
      if (bestXi < 0) continue; // void — leave v/sd NaN, n = 0
      v[i] = bestVal;
      sd[i] = 0;
      n[i] = 1;
      x[i] = positions[bestXi * 3];
      y[i] = positions[bestXi * 3 + 1];
      z[i] = positions[bestXi * 3 + 2];
      continue;
    }

    if (hits === 0) continue;
    const mean = valSum / wSum;
    v[i] = mean;
    sd[i] = Math.sqrt(Math.max(0, valSqSum / wSum - mean * mean));
    n[i] = hits;
    x[i] = cx / wSum;
    y[i] = cy / wSum;
    z[i] = cz / wSum;
  }
}

/** Linearly interpolate across empty samples. */
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
 * Default neighbourhood radius for a section line.
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

/** Export a profile as CSV text: one row per sample point, coordinates included. */
export function profileToCSV(res: ProfileResult, unit = ''): string {
  const lines = ['index,distance,x,y,z,value,std,count'];
  for (let i = 0; i < res.t.length; i++) {
    lines.push(
      [
        i,
        fx(res.t[i]),
        fx(res.x[i]),
        fx(res.y[i]),
        fx(res.z[i]),
        Number.isFinite(res.v[i]) ? fx(res.v[i]) : '',
        Number.isFinite(res.sd[i]) ? fx(res.sd[i]) : '',
        res.n[i],
      ].join(',')
    );
  }
  const head = [
    `# profile field: ${res.field || 'z'}${unit ? ` (${unit})` : ''}`,
    `# endpoints: A(${fx(res.a[0])}, ${fx(res.a[1])}, ${fx(res.a[2])}) → B(${fx(res.b[0])}, ${fx(res.b[1])}, ${fx(res.b[2])})`,
    `# length: ${fx(res.length)}`,
    `# sample points: ${res.t.length}`,
    `# sampling method: ${res.method}`,
    `# neighbourhood radius: ${fx(res.radius)}`,
    `# sampled points: ${res.sampled}`,
  ];
  return head.join('\n') + '\n' + lines.join('\n');
}

function fx(v: number): string {
  return Number.isFinite(v) ? v.toFixed(6) : '';
}
