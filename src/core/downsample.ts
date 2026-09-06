/**
 * Downsampling strategies. All of them operate on index buffers so the source
 * arrays are never copied.
 */

import type { CloudView } from './cloud';
import { t } from '../i18n';

export type DownsampleMethod = 'voxel' | 'random' | 'uniform' | 'none';

export interface DownsampleOptions {
  method: DownsampleMethod;
  /** Target point count for `voxel` (auto-sized) and `random`. */
  target: number;
  /** Explicit voxel edge length (used when > 0, overrides `target`). */
  voxelSize: number;
  /** Keep a deterministic sample (seeded) instead of Math.random. */
  seed: number;
}

export const DOWNSAMPLE_DEFAULTS: DownsampleOptions = {
  method: 'voxel',
  target: 1_500_000,
  voxelSize: 0,
  seed: 1337,
};

export function downsampleIndices(view: CloudView, opts: DownsampleOptions): Uint32Array {
  const n = view.count;
  if (n === 0) return new Uint32Array(0);

  switch (opts.method) {
    case 'none':
      return view.indices.slice();
    case 'uniform':
      return uniformIndices(view, Math.max(1, Math.floor(opts.target)));
    case 'random':
      return randomIndices(view, Math.max(1, Math.floor(opts.target)), opts.seed);
    case 'voxel':
    default: {
      const size = opts.voxelSize > 0 ? opts.voxelSize : estimateVoxelSize(view, opts.target);
      return voxelIndices(view, size);
    }
  }
}

/* ────────── uniform stride ────────── */

function uniformIndices(view: CloudView, target: number): Uint32Array {
  const n = view.count;
  if (target >= n) return view.indices.slice();
  const stride = n / target;
  const out = new Uint32Array(target);
  for (let i = 0; i < target; i++) out[i] = view.indices[Math.min(n - 1, Math.floor(i * stride))];
  return out;
}

/* ────────── random (seeded, partial Fisher–Yates) ────────── */

function randomIndices(view: CloudView, target: number, seed: number): Uint32Array {
  const n = view.count;
  if (target >= n) return view.indices.slice();
  const pool = view.indices.slice();
  let s = seed >>> 0 || 1;
  const rnd = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const k = Math.min(target, n);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.subarray(0, k);
}

/* ────────── voxel grid ────────── */

/**
 * Keeps the point closest to each voxel centre — noticeably better geometry
 * preservation than "first point wins", and it keeps original values intact.
 */
export function voxelIndices(view: CloudView, size: number): Uint32Array {
  const p = view.positions;
  const n = view.count;
  if (size <= 0 || n === 0) return view.indices.slice();

  const b = view.bounds;
  const inv = 1 / size;
  const nxRaw = Math.floor((b.max[0] - b.min[0]) * inv) + 1;
  const nyRaw = Math.floor((b.max[1] - b.min[1]) * inv) + 1;
  const nzRaw = Math.floor((b.max[2] - b.min[2]) * inv) + 1;

  // Clamp grid resolution so the packed key stays within 2^53.
  const cap = 1_048_576; // 2^20 per axis
  const nx = Math.min(nxRaw, cap);
  const ny = Math.min(nyRaw, cap);
  const nz = Math.min(nzRaw, cap);

  const chosen = new Map<number, number>();
  const ox = b.min[0], oy = b.min[1], oz = b.min[2];

  for (let i = 0; i < n; i++) {
    const q = i * 3;
    let gx = Math.floor((p[q] - ox) * inv);
    let gy = Math.floor((p[q + 1] - oy) * inv);
    let gz = Math.floor((p[q + 2] - oz) * inv);
    if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
    if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
    if (gz < 0) gz = 0; else if (gz >= nz) gz = nz - 1;

    const key = (gz * ny + gy) * nx + gx;
    const prev = chosen.get(key);
    if (prev === undefined) {
      chosen.set(key, i);
      continue;
    }
    // Compare squared distance to the voxel centre.
    const cx = ox + (gx + 0.5) * size;
    const cy = oy + (gy + 0.5) * size;
    const cz = oz + (gz + 0.5) * size;
    const dxN = p[q] - cx, dyN = p[q + 1] - cy, dzN = p[q + 2] - cz;
    const dN = dxN * dxN + dyN * dyN + dzN * dzN;
    const pr = prev * 3;
    const dxO = p[pr] - cx, dyO = p[pr + 1] - cy, dzO = p[pr + 2] - cz;
    const dO = dxO * dxO + dyO * dyO + dzO * dzO;
    if (dN < dO) chosen.set(key, i);
  }

  const out = new Uint32Array(chosen.size);
  let k = 0;
  for (const idx of chosen.values()) out[k++] = view.indices[idx];
  // Voxel traversal order is spatial; sort for coherent memory access later.
  out.sort();
  return out;
}

/** Find the voxel edge length that lands closest to `target` points. */
export function estimateVoxelSize(view: CloudView, target: number): number {
  const b = view.bounds;
  const sx = Math.max(b.max[0] - b.min[0], 1e-9);
  const sy = Math.max(b.max[1] - b.min[1], 1e-9);
  const sz = Math.max(b.max[2] - b.min[2], 1e-9);
  const vol = sx * sy * sz;

  // Idealised uniform-density guess, then refine with real occupancy.
  let size = Math.cbrt(vol / Math.max(1, target));
  const n = view.count;
  if (n <= target) return 0;

  let lo = size * 0.25;
  let hi = size * 4;
  for (let iter = 0; iter < 8; iter++) {
    const got = countVoxels(view, size);
    if (Math.abs(got - target) <= target * 0.06) break;
    if (got > target) lo = size;
    else hi = size;
    size = Math.sqrt(lo * hi);
  }
  return size;
}

function countVoxels(view: CloudView, size: number): number {
  const p = view.positions;
  const n = view.count;
  const b = view.bounds;
  const inv = 1 / size;
  const nx = Math.min(Math.floor((b.max[0] - b.min[0]) * inv) + 1, 1_048_576);
  const ny = Math.min(Math.floor((b.max[1] - b.min[1]) * inv) + 1, 1_048_576);
  const nz = Math.min(Math.floor((b.max[2] - b.min[2]) * inv) + 1, 1_048_576);
  const seen = new Set<number>();
  const ox = b.min[0], oy = b.min[1], oz = b.min[2];
  for (let i = 0; i < n; i++) {
    const q = i * 3;
    const gx = clamp(Math.floor((p[q] - ox) * inv), 0, nx - 1);
    const gy = clamp(Math.floor((p[q + 1] - oy) * inv), 0, ny - 1);
    const gz = clamp(Math.floor((p[q + 2] - oz) * inv), 0, nz - 1);
    seen.add((gz * ny + gy) * nx + gx);
  }
  return seen.size;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Human-readable summary of what a downsample pass will do. */
export function describeDownsample(opts: DownsampleOptions): string {
  switch (opts.method) {
    case 'none':
      return t('ds.none');
    case 'uniform':
      return t('ds.uniform', { n: opts.target.toLocaleString() });
    case 'random':
      return t('ds.random', { n: opts.target.toLocaleString() });
    case 'voxel':
    default:
      return opts.voxelSize > 0
        ? t('ds.voxelSize', { s: formatLen(opts.voxelSize) })
        : t('ds.voxelTarget', { n: opts.target.toLocaleString() });
  }
}

export function formatLen(v: number): string {
  if (v >= 1) return `${v.toFixed(3)}`;
  if (v >= 0.001) return `${v.toFixed(4)}`;
  return v.toExponential(2);
}
