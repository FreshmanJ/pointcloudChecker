/**
 * Point cloud data model, sliced views and spatial indexing.
 *
 * Design
 * ──────
 * `PointCloudData`  — immutable, parser output. Stores positions, optional RGB and
 *                     any number of named scalar attributes (temperature, intensity…).
 * `CloudView`       — a *view* over a source cloud defined by an index buffer.
 *                     Downsampling / filtering only produce new index buffers, so the
 *                     heavy source arrays are never duplicated.
 * `SpatialIndex`    — uniform grid (CSR) over a view, used for hover picking and for
 *                     sampling points around a measurement segment.
 */

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface AttributeStats {
  name: string;
  min: number;
  max: number;
  mean: number;
  std: number;
  p01: number;
  p50: number;
  p99: number;
  valid: number;
  invalid: number;
  histogram: Int32Array;
}

export interface PointCloudData {
  id: string;
  name: string;
  format: string;
  /** Number of points actually stored. */
  count: number;
  /** xyz interleaved, length = count * 3. */
  positions: Float32Array;
  /** rgb 0..255 interleaved, length = count * 3 (optional). */
  colors: Uint8Array | null;
  /** Extra per-point scalars: temperature, intensity, curvature… */
  scalars: Map<string, Float32Array>;
  scalarOrder: string[];
  /** Point count in the original file (before any downsampling). */
  sourceCount: number;
  /** Was this cloud downsampled from the source? */
  downsampled: boolean;
  meta: Record<string, string>;
  warnings: string[];
  /** Per-attribute preferred display unit, when known (e.g. °C). */
  units: Map<string, string>;
}

export const EMPTY_BOUNDS: Bounds = {
  min: [0, 0, 0],
  max: [0, 0, 0],
};

let uidCounter = 0;
export function uid(prefix = 'c'): string {
  uidCounter += 1;
  return `${prefix}${uidCounter.toString(36)}${Date.now().toString(36).slice(-3)}`;
}

export function createCloud(partial: Partial<PointCloudData> & { count: number; positions: Float32Array }): PointCloudData {
  return {
    id: partial.id ?? uid('cloud'),
    name: partial.name ?? 'untitled',
    format: partial.format ?? 'unknown',
    count: partial.count,
    positions: partial.positions,
    colors: partial.colors ?? null,
    scalars: partial.scalars ?? new Map(),
    scalarOrder: partial.scalarOrder ?? (partial.scalars ? [...partial.scalars.keys()] : []),
    sourceCount: partial.sourceCount ?? partial.count,
    downsampled: partial.downsampled ?? false,
    meta: partial.meta ?? {},
    warnings: partial.warnings ?? [],
    units: partial.units ?? new Map(),
  };
}

/* ══════════════════════════════════════════════════════════════
   CloudView
   ══════════════════════════════════════════════════════════════ */

export class CloudView {
  readonly source: PointCloudData;
  readonly indices: Uint32Array;
  readonly count: number;

  private posCache: Float32Array | null = null;
  private colCache: Uint8Array | null = null;
  private valCache = new Map<string, Float32Array>();
  private boundsCache: Bounds | null = null;
  private indexCache: SpatialIndex | null = null;
  private statsCache = new Map<string, AttributeStats>();

  constructor(source: PointCloudData, indices?: Uint32Array) {
    this.source = source;
    this.indices = indices ?? makeIdentity(source.count);
    this.count = this.indices.length;
  }

  static full(source: PointCloudData): CloudView {
    return new CloudView(source, makeIdentity(source.count));
  }

  get positions(): Float32Array {
    if (this.posCache) return this.posCache;
    const src = this.source.positions;
    const idx = this.indices;
    const out = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const s = idx[i] * 3;
      const d = i * 3;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
    }
    this.posCache = out;
    return out;
  }

  get colors(): Uint8Array | null {
    if (!this.source.colors) return null;
    if (this.colCache) return this.colCache;
    const src = this.source.colors;
    const idx = this.indices;
    const out = new Uint8Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const s = idx[i] * 3;
      const d = i * 3;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
    }
    this.colCache = out;
    return out;
  }

  /** Materialized values of a named scalar attribute (null when absent). */
  values(name: string): Float32Array | null {
    if (!name) return null;
    const srcArr = this.source.scalars.get(name);
    if (!srcArr) return null;
    const hit = this.valCache.get(name);
    if (hit) return hit;
    const idx = this.indices;
    const out = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = srcArr[idx[i]];
    this.valCache.set(name, out);
    return out;
  }

  /** Raw value of a scalar for a *view* index. */
  valueAt(name: string, viewIndex: number): number {
    const arr = this.source.scalars.get(name);
    if (!arr) return NaN;
    return arr[this.indices[viewIndex]];
  }

  positionAt(viewIndex: number): [number, number, number] {
    const s = this.indices[viewIndex] * 3;
    const p = this.source.positions;
    return [p[s], p[s + 1], p[s + 2]];
  }

  sourceIndex(viewIndex: number): number {
    return this.indices[viewIndex];
  }

  get bounds(): Bounds {
    if (this.boundsCache) return this.boundsCache;
    const p = this.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) {
      this.boundsCache = { ...EMPTY_BOUNDS };
      return this.boundsCache;
    }
    this.boundsCache = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    return this.boundsCache;
  }

  get diagonal(): number {
    const b = this.bounds;
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  }

  get center(): [number, number, number] {
    const b = this.bounds;
    return [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
  }

  get index(): SpatialIndex {
    if (!this.indexCache) this.indexCache = new SpatialIndex(this.positions, this.count);
    return this.indexCache;
  }

  /** Statistics of a named scalar over the *view* (cached). */
  stats(name: string): AttributeStats | null {
    if (!name) return null;
    const hit = this.statsCache.get(name);
    if (hit) return hit;
    const arr = this.values(name);
    if (!arr) return null;
    const st = computeStats(name, arr);
    this.statsCache.set(name, st);
    return st;
  }

  /** Drop cached derived data (call when the view is rebuilt). */
  dispose(): void {
    this.posCache = null;
    this.colCache = null;
    this.valCache.clear();
    this.boundsCache = null;
    this.indexCache = null;
    this.statsCache.clear();
  }
}

export function makeIdentity(n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

/* ══════════════════════════════════════════════════════════════
   Statistics
   ══════════════════════════════════════════════════════════════ */

export const HIST_BINS = 56;

export function computeStats(name: string, arr: Float32Array): AttributeStats {
  const n = arr.length;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let invalid = 0;

  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) {
      invalid++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const valid = n - invalid;
  if (valid === 0) {
    return {
      name,
      min: 0, max: 0, mean: 0, std: 0,
      p01: 0, p50: 0, p99: 0,
      valid: 0, invalid,
      histogram: new Int32Array(HIST_BINS),
    };
  }
  const mean = sum / valid;
  const variance = Math.max(0, sumSq / valid - mean * mean);
  const std = Math.sqrt(variance);

  const hist = new Int32Array(HIST_BINS);
  const span = max - min;
  const scale = span > 0 ? (HIST_BINS - 1) / span : 0;
  const sample = new Float64Array(Math.min(valid, 200_000));
  let si = 0;
  const stride = Math.max(1, Math.floor(n / 200_000));
  for (let i = 0; i < n; i += stride) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    hist[(v - min) * scale < 0 ? 0 : Math.round((v - min) * scale)]++;
    if (si < sample.length) sample[si++] = v;
  }
  const s = sample.subarray(0, si).sort();
  const q = (p: number) => s[Math.min(si - 1, Math.max(0, Math.floor(p * si)))];

  return {
    name, min, max, mean, std,
    p01: q(0.01), p50: q(0.5), p99: q(0.99),
    valid, invalid,
    histogram: hist,
  };
}

/**
 * Value at quantile `p` (0..1) of an attribute, interpolated from its
 * histogram. Resolution is one histogram bin (~1/56 of the range), which is
 * plenty for colour clipping and filter presets.
 */
export function quantileOf(st: AttributeStats, p: number): number {
  const h = st.histogram;
  if (!h || h.length === 0) return st.min;
  let total = 0;
  for (let i = 0; i < h.length; i++) total += h[i];
  if (total <= 0) return st.min;
  const target = Math.max(0, Math.min(1, p)) * total;
  let acc = 0;
  const span = st.max - st.min;
  for (let i = 0; i < h.length; i++) {
    const next = acc + h[i];
    if (next >= target) {
      const within = h[i]! > 0 ? (target - acc) / h[i]! : 0;
      return st.min + ((i + within) / h.length) * span;
    }
    acc = next;
  }
  return st.max;
}

/* ══════════════════════════════════════════════════════════════
   Spatial index — uniform grid, CSR layout
   ══════════════════════════════════════════════════════════════ */

const MAX_CELLS = 2_400_000;

export interface RayHit {
  index: number;
  distance: number;
  t: number;
}

export class SpatialIndex {
  readonly count: number;
  readonly bounds: Bounds;
  readonly dims: [number, number, number];
  readonly cell: [number, number, number];
  readonly origin: [number, number, number];

  private cellStart: Int32Array; // length = numCells + 1
  private items: Int32Array; // length = count
  private stamp: Int32Array;
  private stampId = 0;

  constructor(positions: Float32Array, count: number) {
    this.count = count;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 1; }
    const sx = Math.max(maxX - minX, 1e-6);
    const sy = Math.max(maxY - minY, 1e-6);
    const sz = Math.max(maxZ - minZ, 1e-6);
    this.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };

    // Aim for ~2 points per cell, bounded by MAX_CELLS.
    const targetCells = Math.min(Math.max(1, Math.floor(count / 2)), MAX_CELLS);
    const vol = sx * sy * sz;
    const unit = Math.cbrt(vol / targetCells);
    let nx = Math.max(1, Math.min(1024, Math.round(sx / unit)));
    let ny = Math.max(1, Math.min(1024, Math.round(sy / unit)));
    let nz = Math.max(1, Math.min(1024, Math.round(sz / unit)));
    while (nx * ny * nz > MAX_CELLS) {
      if (nx >= ny && nx >= nz) nx = Math.max(1, Math.floor(nx / 2));
      else if (ny >= nz) ny = Math.max(1, Math.floor(ny / 2));
      else nz = Math.max(1, Math.floor(nz / 2));
    }
    this.dims = [nx, ny, nz];
    this.cell = [sx / nx, sy / ny, sz / nz];
    this.origin = [minX, minY, minZ];

    const numCells = nx * ny * nz;
    this.cellStart = new Int32Array(numCells + 1);
    this.items = new Int32Array(count);
    this.stamp = new Int32Array(numCells);

    const cellOf = new Int32Array(count);
    const cx = this.cell[0], cy = this.cell[1], cz = this.cell[2];
    for (let i = 0; i < count; i++) {
      const p = i * 3;
      let gx = Math.floor((positions[p] - minX) / cx);
      let gy = Math.floor((positions[p + 1] - minY) / cy);
      let gz = Math.floor((positions[p + 2] - minZ) / cz);
      if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
      if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
      if (gz < 0) gz = 0; else if (gz >= nz) gz = nz - 1;
      const c = (gz * ny + gy) * nx + gx;
      cellOf[i] = c;
      this.cellStart[c + 1]++;
    }
    for (let c = 0; c < numCells; c++) this.cellStart[c + 1] += this.cellStart[c];
    const cursor = this.cellStart.slice(0, numCells);
    for (let i = 0; i < count; i++) this.items[cursor[cellOf[i]]++] = i;
  }

  /** Cell index containing a point, or -1 when outside the grid. */
  cellIndex(x: number, y: number, z: number): number {
    const [nx, ny, nz] = this.dims;
    let gx = Math.floor((x - this.origin[0]) / this.cell[0]);
    let gy = Math.floor((y - this.origin[1]) / this.cell[1]);
    let gz = Math.floor((z - this.origin[2]) / this.cell[2]);
    if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) return -1;
    return (gz * ny + gy) * nx + gx;
  }

  /** Inclusive cell range overlapping an AABB. */
  private range(
    lo: [number, number, number],
    hi: [number, number, number]
  ): [number, number, number, number, number, number] {
    const [nx, ny, nz] = this.dims;
    const c = this.cell;
    const gx0 = clampi(Math.floor((lo[0] - this.origin[0]) / c[0]), 0, nx - 1);
    const gy0 = clampi(Math.floor((lo[1] - this.origin[1]) / c[1]), 0, ny - 1);
    const gz0 = clampi(Math.floor((lo[2] - this.origin[2]) / c[2]), 0, nz - 1);
    const gx1 = clampi(Math.floor((hi[0] - this.origin[0]) / c[0]), 0, nx - 1);
    const gy1 = clampi(Math.floor((hi[1] - this.origin[1]) / c[1]), 0, ny - 1);
    const gz1 = clampi(Math.floor((hi[2] - this.origin[2]) / c[2]), 0, nz - 1);
    return [gx0, gy0, gz0, gx1, gy1, gz1];
  }

  /**
   * Nearest point to a ray, within `radius` (perpendicular distance).
   * Uses a coarse ray-march over the grid, testing each visited cell's 3×3×3
   * neighbourhood exactly once.
   */
  raycast(
    positions: Float32Array,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    radius: number,
    tMin = 0,
    tMax = Infinity
  ): RayHit | null {
    if (this.count === 0) return null;

    // Clip the ray against the cloud AABB.
    const b = this.bounds;
    const clip = clipRayAabb(ox, oy, oz, dx, dy, dz, b.min, b.max);
    if (!clip) return null;
    let t0 = Math.max(tMin, clip[0]);
    let t1 = Math.min(tMax, clip[1]);
    if (t1 < t0) return null;

    // Expand the box a little so points near the hull are still found.
    const pad = radius;
    t0 = Math.max(tMin, t0 - pad);
    t1 = Math.min(tMax, t1 + pad);

    const step = Math.min(this.cell[0], this.cell[1], this.cell[2]) * 0.75;
    const steps = Math.min(Math.ceil((t1 - t0) / step) + 1, 4096);
    const dt = (t1 - t0) / Math.max(1, steps - 1);

    const r2 = radius * radius;
    this.stampId++;
    const stamp = this.stamp;
    const [nx, ny] = this.dims;

    let best = -1;
    let bestD2 = r2;
    let bestT = Infinity;

    for (let s = 0; s < steps; s++) {
      const t = t0 + s * dt;
      const px = ox + dx * t;
      const py = oy + dy * t;
      const pz = oz + dz * t;
      const [gx0, gy0, gz0, gx1, gy1, gz1] = this.range(
        [px - radius, py - radius, pz - radius],
        [px + radius, py + radius, pz + radius]
      );
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = (gz * ny + gy) * nx;
          for (let gx = gx0; gx <= gx1; gx++) {
            const c = rowBase + gx;
            if (stamp[c] === this.stampId) continue;
            stamp[c] = this.stampId;
            const end = this.cellStart[c + 1];
            for (let k = this.cellStart[c]; k < end; k++) {
              const i = this.items[k];
              const p = i * 3;
              const vx = positions[p] - ox;
              const vy = positions[p + 1] - oy;
              const vz = positions[p + 2] - oz;
              const tt = vx * dx + vy * dy + vz * dz;
              if (tt < t0 || tt > t1) continue;
              const ex = vx - dx * tt;
              const ey = vy - dy * tt;
              const ez = vz - dz * tt;
              const d2 = ex * ex + ey * ey + ez * ez;
              // Prefer perpendicular closeness, then depth.
              if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) < 1e-9 && tt < bestT)) {
                bestD2 = d2;
                best = i;
                bestT = tt;
              }
            }
          }
        }
      }
    }

    if (best < 0) return null;
    return { index: best, distance: Math.sqrt(bestD2), t: bestT };
  }

  /** Nearest point to a position (unbounded search radius → grid walk). */
  nearest(
    positions: Float32Array,
    x: number, y: number, z: number,
    maxDist = Infinity
  ): number {
    if (this.count === 0) return -1;
    let r = Math.min(this.cell[0], this.cell[1], this.cell[2]);
    let best = -1;
    let bestD2 = maxDist * maxDist;
    const [nx, ny] = this.dims;
    const b = this.bounds;

    for (let iter = 0; iter < 24; iter++) {
      const [gx0, gy0, gz0, gx1, gy1, gz1] = this.range(
        [x - r, y - r, z - r],
        [x + r, y + r, z + r]
      );
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = (gz * ny + gy) * nx;
          for (let gx = gx0; gx <= gx1; gx++) {
            const c = rowBase + gx;
            const end = this.cellStart[c + 1];
            for (let k = this.cellStart[c]; k < end; k++) {
              const i = this.items[k];
              const p = i * 3;
              const dx = positions[p] - x;
              const dy = positions[p + 1] - y;
              const dz = positions[p + 2] - z;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < bestD2) { bestD2 = d2; best = i; }
            }
          }
        }
      }
      if (best >= 0 || r > Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])) break;
      r *= 2;
    }
    return best;
  }

  /**
   * Collect points whose distance to the segment A→B is < radius.
   * Returns view indices plus their normalised position along the segment.
   */
  alongSegment(
    positions: Float32Array,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    radius: number,
    maxPoints = 400_000
  ): { indices: Uint32Array; t: Float32Array; n: number } {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const outI = new Uint32Array(Math.min(this.count, maxPoints));
    const outT = new Float32Array(outI.length);
    let n = 0;
    if (len <= 0) return { indices: outI, t: outT, n: 0 };

    const ux = dx / len, uy = dy / len, uz = dz / len;
    const step = Math.min(this.cell[0], this.cell[1], this.cell[2]) * 0.75;
    const steps = Math.min(Math.ceil(len / step) + 1, 8192);
    const r2 = radius * radius;
    this.stampId++;
    const stamp = this.stamp;
    const [nxg, nyg] = this.dims;

    for (let s = 0; s <= steps && n < outI.length; s++) {
      const t = (s / steps) * len;
      const px = ax + ux * t, py = ay + uy * t, pz = az + uz * t;
      const [gx0, gy0, gz0, gx1, gy1, gz1] = this.range(
        [px - radius, py - radius, pz - radius],
        [px + radius, py + radius, pz + radius]
      );
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const rowBase = (gz * nyg + gy) * nxg;
          for (let gx = gx0; gx <= gx1; gx++) {
            const c = rowBase + gx;
            if (stamp[c] === this.stampId) continue;
            stamp[c] = this.stampId;
            const end = this.cellStart[c + 1];
            for (let k = this.cellStart[c]; k < end && n < outI.length; k++) {
              const i = this.items[k];
              const p = i * 3;
              const vx = positions[p] - ax;
              const vy = positions[p + 1] - ay;
              const vz = positions[p + 2] - az;
              let tp = vx * ux + vy * uy + vz * uz;
              if (tp < -radius || tp > len + radius) continue;
              if (tp < 0) tp = 0; else if (tp > len) tp = len;
              const ex = vx - ux * tp;
              const ey = vy - uy * tp;
              const ez = vz - uz * tp;
              if (ex * ex + ey * ey + ez * ez > r2) continue;
              outI[n] = i;
              outT[n] = tp;
              n++;
            }
          }
        }
      }
    }
    return { indices: outI, t: outT, n };
  }
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Slab test; returns [tEnter, tExit] in ray parameter units, or null. */
export function clipRayAabb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  bmin: [number, number, number],
  bmax: [number, number, number]
): [number, number] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < bmin[a] || o[a] > bmax[a]) return null;
      continue;
    }
    const inv = 1 / d[a];
    let ta = (bmin[a] - o[a]) * inv;
    let tb = (bmax[a] - o[a]) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t1 < t0) return null;
  }
  return [t0, t1];
}
