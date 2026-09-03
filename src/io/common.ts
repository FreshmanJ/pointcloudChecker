/** Shared parsing helpers. */

import type { PointCloudData } from '../core/cloud';
import { createCloud } from '../core/cloud';
import { guessUnitFor } from '../core/colormap';

export interface ParseOutcome {
  data: PointCloudData;
  warnings: string[];
}

export type ProgressFn = (ratio: number, label: string) => void;

/** User-chosen coordinate mapping for delimited-text point clouds. */
export interface ColumnSelection {
  mode: '2d' | '3d';
  /** Source column index (0-based) for each axis. `z` is -1 in 2D mode. */
  x: number;
  y: number;
  z: number;
}

/** Lightweight column preview used to drive the coordinate-picking dialog. */
export interface TextColumnPreview {
  ext: string;
  hasHeader: boolean;
  delim: number;
  /** How many data rows were sampled to estimate per-column numeric validity. */
  sampledRows: number;
  columns: { index: number; name: string; sample: number[]; /** Rows (of `sampledRows`) where this column held a finite number. */ validCount: number }[];
  /** Sampled data rows (row-major), each length = `columns.length`, `NaN` for a non-numeric field. Lets the dialog predict how many rows would parse for *any* coordinate selection without re-reading the file. */
  rows: number[][];
}

/** Delimited-text formats whose coordinate columns must be chosen by the user. */
export const TEXT_FORMATS = new Set(['csv', 'txt', 'xyz', 'xyzn', 'pts', 'ptx']);

export function isTextColumnFormat(ext: string): boolean {
  return TEXT_FORMATS.has(ext.toLowerCase());
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function baseName(name: string): string {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return i < 0 ? name : name.slice(i + 1);
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? name : name.slice(0, i);
}

/** Yield to the browser so the loading overlay keeps animating. */
export function yieldUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ────────── text scanning ────────── */

const C_SPACE = 32;
const C_TAB = 9;
const C_CR = 13;
const C_COMMA = 44;
const C_SEMI = 59;
const C_HASH = 35;
const C_SLASH = 47;
const C_DOT = 46;
const C_MINUS = 45;
const C_PLUS = 43;
const C_e = 101;
const C_E = 69;

function isWs(c: number): boolean {
  return c === C_SPACE || c === C_TAB || c === C_CR;
}

/** Read one number starting at `i`; returns [value, nextIndex]. NaN when none. */
export function readNumber(text: string, i: number, end: number, decimalDot = true): [number, number] {
  while (i < end && isWs(text.charCodeAt(i))) i++;
  if (i >= end) return [NaN, end];
  const start = i;
  let c = text.charCodeAt(i);
  if (c === C_MINUS || c === C_PLUS) { i++; c = i < end ? text.charCodeAt(i) : 0; }
  let digits = 0;
  while (i < end) {
    c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) { i++; digits++; }
    else break;
  }
  let isFloat = false;
  if (i < end && (text.charCodeAt(i) === C_DOT || (!decimalDot && text.charCodeAt(i) === C_COMMA))) {
    isFloat = true;
    i++;
    while (i < end) {
      c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) { i++; digits++; }
      else break;
    }
  }
  if (digits === 0) return [NaN, start + 1];
  if (i < end && (text.charCodeAt(i) === C_e || text.charCodeAt(i) === C_E)) {
    isFloat = true;
    const save = i;
    i++;
    if (i < end && (text.charCodeAt(i) === C_MINUS || text.charCodeAt(i) === C_PLUS)) i++;
    let ed = 0;
    while (i < end) {
      c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) { i++; ed++; }
      else break;
    }
    if (ed === 0) i = save;
  }
  const raw = text.slice(start, i);
  const v = isFloat ? parseFloat(raw.replace(',', '.')) : parseInt(raw, 10);
  return [v, i];
}

export interface RowScan {
  count: number;
  /** Index of the first non-numeric token (for header detection). */
  nonNumeric: boolean;
}

/**
 * Split a line into per-column numbers. `delim` is a single char code; when it
 * is a space any run of whitespace separates fields.
 *
 * Unlike a plain "collect the numbers" scan, this is COLUMN-ALIGNED: every
 * delimiter-separated field becomes one output slot, with `NaN` for
 * non-numeric fields. That keeps coordinates in their real columns even when a
 * file carries text columns (IDs, labels) — which is exactly what the
 * coordinate-picker dialog relies on.
 */
export function scanRow(text: string, from: number, to: number, delim: number, out: Float64Array): RowScan {
  let col = 0;
  let nonNumeric = false;
  const spaceDelim = delim === C_SPACE;
  let i = from;
  while (i < to && col < out.length) {
    // Skip field separators (and surrounding whitespace).
    while (i < to) {
      const c = text.charCodeAt(i);
      if (spaceDelim ? isWs(c) : c === delim || isWs(c)) i++;
      else break;
    }
    if (i >= to) break;
    // Find the end of this field (next separator).
    let j = i;
    while (j < to) {
      const c = text.charCodeAt(j);
      if (spaceDelim ? isWs(c) : c === delim) break;
      j++;
    }
    const [v] = readNumber(text, i, j);
    if (Number.isNaN(v)) {
      nonNumeric = true;
      out[col++] = NaN;
    } else {
      out[col++] = v;
    }
    i = j; // next iteration skips the separator
  }
  return { count: col, nonNumeric };
}

export function isCommentLine(text: string, from: number, to: number): boolean {
  if (from >= to) return false;
  const c = text.charCodeAt(from);
  if (c === C_HASH) return true;
  if (c === C_SLASH && from + 1 < to && text.charCodeAt(from + 1) === C_SLASH) return true;
  return false;
}

export function splitHeaderTokens(text: string, from: number, to: number, delim: number): string[] {
  const raw = text.slice(from, to);
  if (delim === C_SPACE) return raw.trim().split(/\s+/);
  const ch = String.fromCharCode(delim);
  return raw.split(ch).map((s) => s.trim());
}

/** Guess the delimiter from a sample line. */
export function detectDelimiter(text: string, from: number, to: number): number {
  let comma = 0, semi = 0, tab = 0, space = 0;
  let prevWs = false;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c === C_COMMA) comma++;
    else if (c === C_SEMI) semi++;
    else if (c === C_TAB) tab++;
    else if (c === C_SPACE) {
      const ws = true;
      if (!prevWs) space++;
      prevWs = ws;
      continue;
    }
    prevWs = false;
  }
  const best = [
    [tab, C_TAB],
    [semi, C_SEMI],
    [comma, C_COMMA],
    [space, C_SPACE],
  ].sort((a, b) => (b[0] as number) - (a[0] as number))[0];
  return (best[0] as number) > 0 ? (best[1] as number) : C_SPACE;
}

/* ────────── column naming ────────── */

const COORD_ALIASES: Record<string, 0 | 1 | 2> = {
  x: 0, y: 1, z: 2,
  px: 0, py: 1, pz: 2,
  posx: 0, posy: 1, posz: 2,
  positionx: 0, positiony: 1, positionz: 2,
  easting: 0, northing: 1, elevation: 2,
  east: 0, north: 1, elev: 2, depth: 2,
  longitude: 0, latitude: 1, altitude: 2, height: 2,
  lon: 0, lat: 1, alt: 2,
  '坐标x': 0, '坐标y': 1, '坐标z': 2,
  'x坐标': 0, 'y坐标': 1, 'z坐标': 2,
  高程: 2, 海拔: 2,
};

const COLOR_ALIASES: Record<string, 0 | 1 | 2> = {
  r: 0, g: 1, b: 2,
  red: 0, green: 1, blue: 2,
  diffuse_red: 0, diffuse_green: 1, diffuse_blue: 2,
  reflectance_r: 0, reflectance_g: 1, reflectance_b: 2,
  红: 0, 绿: 1, 蓝: 2,
};

export function classifyColumn(token: string): 'x' | 'y' | 'z' | 'r' | 'g' | 'b' | null {
  const t = token.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  const coord = COORD_ALIASES[t];
  if (coord !== undefined) return (['x', 'y', 'z'] as const)[coord];
  const color = COLOR_ALIASES[t];
  if (color !== undefined) return (['r', 'g', 'b'] as const)[color];
  return null;
}

export function normalizeName(token: string): string {
  return token.trim().replace(/^["']|["']$/g, '') || 'attr';
}

/* ────────── finalisation ────────── */

export function finishCloud(
  partial: Partial<PointCloudData> & { count: number; positions: Float32Array },
  sourceName: string,
  format: string
): PointCloudData {
  const warnings = partial.warnings ?? [];
  const units = partial.units ?? new Map<string, string>();
  for (const name of partial.scalarOrder ?? []) {
    if (!units.has(name)) {
      const u = guessUnitFor(name);
      if (u) units.set(name, u);
    }
  }
  return createCloud({
    name: stripExt(sourceName),
    format,
    ...partial,
    units,
    warnings,
    meta: {
      源文件: sourceName,
      格式: format,
      ...(partial.meta ?? {}),
    },
  });
}
