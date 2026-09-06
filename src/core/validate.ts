/**
 * Compliance checks and sanitisation for freshly-parsed clouds.
 */

import type { Bounds, PointCloudData } from './cloud';
import { createCloud } from './cloud';
import { t } from '../i18n';

export type IssueLevel = 'ok' | 'info' | 'warn' | 'err';

export interface Issue {
  level: IssueLevel;
  title: string;
  desc?: string;
}

export interface ComplianceLimits {
  /** Above this count the browser will struggle — auto-downsample. */
  soft: number;
  /** Above this count we refuse to render at full resolution. */
  hard: number;
  /** Coordinate magnitudes beyond this are almost certainly a unit mistake. */
  coordMagnitude: number;
}

export const DEFAULT_LIMITS: ComplianceLimits = {
  soft: 1_500_000,
  hard: 40_000_000,
  coordMagnitude: 1e7,
};

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  invalidPoints: number;
  duplicateRatio: number;
  needsDownsample: boolean;
  suggestedTarget: number;
  bounds: Bounds;
  /** Fraction of points carrying RGB. */
  colorCoverage: number;
}

export function validateCloud(data: PointCloudData, limits = DEFAULT_LIMITS): ValidationResult {
  const issues: Issue[] = [];
  const n = data.count;

  /* --- geometry sanity ------------------------------------------------ */
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let invalid = 0;
  const p = data.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      invalid++;
      continue;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const bounds: Bounds =
    Number.isFinite(minX)
      ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
      : { min: [0, 0, 0], max: [0, 0, 0] };

  /* --- hard failures --------------------------------------------------- */
  if (n === 0) {
    issues.push({ level: 'err', title: t('val.empty'), desc: t('val.emptyDesc') });
    return {
      ok: false, issues, invalidPoints: invalid, duplicateRatio: 0,
      needsDownsample: false, suggestedTarget: 0, bounds, colorCoverage: 0,
    };
  }

  if (n > limits.hard) {
    issues.push({
      level: 'err',
      title: t('val.tooMany', { n: n.toLocaleString() }),
      desc: t('val.tooManyDesc', { cap: limits.hard.toLocaleString() }),
    });
    return {
      ok: false, issues, invalidPoints: invalid, duplicateRatio: 0,
      needsDownsample: true, suggestedTarget: limits.soft, bounds, colorCoverage: 0,
    };
  }

  /* --- attribute consistency ------------------------------------------ */
  let badAttr = 0;
  for (const [name, arr] of data.scalars) {
    if (arr.length !== n) {
      badAttr++;
      issues.push({
        level: 'err',
        title: t('val.attrLen', { name }),
        desc: t('val.attrLenDesc', { n: n.toLocaleString(), m: arr.length.toLocaleString() }),
      });
    }
  }

  /* --- invalid coordinates -------------------------------------------- */
  const invalidRatio = invalid / n;
  if (invalid > 0) {
      issues.push({
        level: invalidRatio > 0.05 ? 'warn' : 'info',
        title: t('val.invalidCoords', { n: invalid.toLocaleString() }),
        desc: t('val.invalidCoordsDesc', { p: (invalidRatio * 100).toFixed(2) }),
      });
  }

  /* --- degenerate extents --------------------------------------------- */
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  const flat: string[] = [];
  if (sx < 1e-9) flat.push('X');
  if (sy < 1e-9) flat.push('Y');
  if (sz < 1e-9) flat.push('Z');
  if (flat.length === 3) {
    issues.push({ level: 'warn', title: t('val.coincident'), desc: t('val.coincidentDesc') });
  } else if (flat.length > 0) {
    issues.push({
      level: 'info',
      title: t('val.flat', { d: flat.join(' / ') }),
      desc: t('val.flatDesc'),
    });
  }

  /* --- coordinate magnitude ------------------------------------------- */
  const maxAbs = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY), Math.abs(minZ), Math.abs(maxZ));
  if (maxAbs > limits.coordMagnitude) {
    issues.push({
      level: 'warn',
      title: t('val.magnitude'),
      desc: t('val.magnitudeDesc', { v: maxAbs.toExponential(2) }),
    });
  }

  /* --- duplicates ------------------------------------------------------ */
  const dupRatio = estimateDuplicateRatio(data);
  if (dupRatio > 0.3) {
    issues.push({
      level: 'warn',
      title: t('val.duplicate', { p: (dupRatio * 100).toFixed(0) }),
      desc: t('val.duplicateDesc'),
    });
  }

  /* --- colour coverage -------------------------------------------------- */
  const colorCoverage = data.colors ? 1 : 0;
  if (!data.colors && data.scalarOrder.length === 0) {
    issues.push({
      level: 'info',
      title: t('val.coordsOnly'),
      desc: t('val.coordsOnlyDesc'),
    });
  }

  /* --- size verdict ----------------------------------------------------- */
  const needsDownsample = n > limits.soft;
  const suggestedTarget = limits.soft;
  if (needsDownsample) {
    issues.push({
      level: 'warn',
      title: t('val.overThreshold', { n: n.toLocaleString(), cap: limits.soft.toLocaleString() }),
      desc: t('val.overThresholdDesc', { cap: suggestedTarget.toLocaleString() }),
    });
  } else {
    issues.push({ level: 'ok', title: t('val.ok', { n: n.toLocaleString() }), desc: t('val.okDesc') });
  }

  const ok = !issues.some((i) => i.level === 'err');
  return {
    ok, issues, invalidPoints: invalid, duplicateRatio: dupRatio,
    needsDownsample, suggestedTarget, bounds, colorCoverage,
  };
}

/** Remove points with non-finite coordinates (and repaire mismatched attributes). */
export function sanitizeCloud(data: PointCloudData): { data: PointCloudData; removed: number } {
  const n = data.count;
  const p = data.positions;
  const keep = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const q = i * 3;
    if (Number.isFinite(p[q]) && Number.isFinite(p[q + 1]) && Number.isFinite(p[q + 2])) keep[k++] = i;
  }
  const removed = n - k;
  if (removed === 0) {
    // Still drop attributes whose length does not match.
    const clean = new Map(data.scalars);
    for (const [name, arr] of data.scalars) if (arr.length !== n) clean.delete(name);
    return {
      data: { ...data, scalars: clean, scalarOrder: data.scalarOrder.filter((nn) => clean.has(nn)) },
      removed: 0,
    };
  }
  const idx = keep.subarray(0, k);
  const np = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) {
    const s = idx[i] * 3, d = i * 3;
    np[d] = p[s]; np[d + 1] = p[s + 1]; np[d + 2] = p[s + 2];
  }
  let nc: Uint8Array | null = null;
  if (data.colors) {
    nc = new Uint8Array(k * 3);
    for (let i = 0; i < k; i++) {
      const s = idx[i] * 3, d = i * 3;
      nc[d] = data.colors[s]; nc[d + 1] = data.colors[s + 1]; nc[d + 2] = data.colors[s + 2];
    }
  }
  const scalars = new Map<string, Float32Array>();
  const order: string[] = [];
  for (const name of data.scalarOrder) {
    const src = data.scalars.get(name);
    if (!src || src.length !== n) continue;
    const out = new Float32Array(k);
    for (let i = 0; i < k; i++) out[i] = src[idx[i]];
    scalars.set(name, out);
    order.push(name);
  }
  return {
    data: createCloud({
      ...data,
      count: k,
      positions: np,
      colors: nc,
      scalars,
      scalarOrder: order,
      sourceCount: data.sourceCount,
      meta: data.meta,
      warnings: data.warnings,
      units: data.units,
    }),
    removed,
  };
}

function estimateDuplicateRatio(data: PointCloudData): number {
  const n = data.count;
  const sample = Math.min(n, 20_000);
  const stride = Math.max(1, Math.floor(n / sample));
  const seen = new Set<number>();
  let dup = 0;
  let total = 0;
  const p = data.positions;
  for (let i = 0; i < n; i += stride) {
    const q = i * 3;
    // Quantise to ~1e-4 of the extent to count near-duplicates.
    const key = (Math.round(p[q] * 1000) * 73856093) ^ (Math.round(p[q + 1] * 1000) * 19349663) ^ (Math.round(p[q + 2] * 1000) * 83492791);
    total++;
    if (seen.has(key)) dup++;
    else seen.add(key);
  }
  return total ? dup / total : 0;
}
