/**
 * LAS (1.0 – 1.4) and LAZ (laszip) reader.
 *
 * Extracts the standard dimensions plus any "extra bytes" declared in the
 * LASF_Spec VLR (record id 4), which is how most per-point measurements
 * (temperature, curvature, deformation…) travel inside a LAS file.
 */

import type { PointCloudData } from '../core/cloud';
import { t, tMeta } from '../i18n';
import { finishCloud, yieldUI, type ProgressFn } from './common';
import type { ParseOutcome } from './common';

/* ────────── constants ────────── */

export const LEGACY_LENGTH = [20, 28, 26, 34, 57, 63];
export const NEW_LENGTH: Record<number, number> = { 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 };

const EXTRA_TYPES: { size: number; kind: 'u' | 'i' | 'f'; elem: number }[] = [
  { size: 0, kind: 'u', elem: 1 },   // 0 undocumented
  { size: 1, kind: 'u', elem: 1 },   // 1 unsigned char
  { size: 1, kind: 'i', elem: 1 },   // 2 char
  { size: 2, kind: 'u', elem: 1 },   // 3 unsigned short
  { size: 2, kind: 'i', elem: 1 },   // 4 short
  { size: 4, kind: 'u', elem: 1 },   // 5 unsigned long
  { size: 4, kind: 'i', elem: 1 },   // 6 long
  { size: 8, kind: 'u', elem: 2 },   // 7 unsigned long long (read as float64-ish)
  { size: 8, kind: 'i', elem: 2 },   // 8 long long
  { size: 4, kind: 'f', elem: 1 },   // 9 float
  { size: 8, kind: 'f', elem: 1 },   // 10 double
  { size: 2, kind: 'u', elem: 1 },   // 11 unsigned char[2]
  { size: 2, kind: 'i', elem: 1 },   // 12 char[2]
  { size: 4, kind: 'u', elem: 1 },   // 13 unsigned short[2]
  { size: 4, kind: 'i', elem: 1 },   // 14 short[2]
  { size: 8, kind: 'u', elem: 1 },   // 15 unsigned long[2]
  { size: 8, kind: 'i', elem: 1 },   // 16 long[2]
  { size: 16, kind: 'u', elem: 1 },  // 17 unsigned long long[2]
  { size: 16, kind: 'i', elem: 1 },  // 18 long long[2]
  { size: 8, kind: 'f', elem: 1 },   // 19 float[2]
  { size: 16, kind: 'f', elem: 1 },  // 20 double[2]
  { size: 3, kind: 'u', elem: 1 },   // 21 unsigned char[3]
  { size: 3, kind: 'i', elem: 1 },   // 22 char[3]
  { size: 6, kind: 'u', elem: 1 },   // 23 unsigned short[3]
  { size: 6, kind: 'i', elem: 1 },   // 24 short[3]
  { size: 12, kind: 'u', elem: 1 },  // 25 unsigned long[3]
  { size: 12, kind: 'i', elem: 1 },  // 26 long[3]
  { size: 24, kind: 'u', elem: 1 },  // 27 unsigned long long[3]
  { size: 24, kind: 'i', elem: 1 },  // 28 long long[3]
  { size: 12, kind: 'f', elem: 1 },  // 29 float[3]
  { size: 24, kind: 'f', elem: 1 },  // 30 double[3]
];

export interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  headerSize: number;
  offsetToPoints: number;
  numVLR: number;
  pointFormat: number;
  pointLength: number;
  legacyCount: number;
  count: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  globalEncoding: number;
  hasColor: boolean;
  hasGps: boolean;
  hasNir: boolean;
  evlrOffset: number;
  evlrCount: number;
}

export interface ExtraByteDef {
  name: string;
  dataType: number;
  size: number;
  kind: 'u' | 'i' | 'f';
  offset: number;
  description: string;
  noData?: number;
}

export function parseLasHeader(buf: ArrayBuffer): LasHeader {
  if (buf.byteLength < 227) throw new Error(t('io.err.lasTooSmall'));
  const dv = new DataView(buf);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error(t('io.err.lasMagic'));

  const versionMajor = dv.getUint8(24);
  const versionMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const offsetToPoints = dv.getUint32(96, true);
  const numVLR = dv.getUint32(100, true);
  const pointFormat = dv.getUint8(104) & 0x3f;
  const pointLength = dv.getUint16(105, true);
  const legacyCount = dv.getUint32(107, true);
  const globalEncoding = dv.getUint16(6, true);

  const scale: [number, number, number] = [
    dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true),
  ];
  const offset: [number, number, number] = [
    dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true),
  ];
  const bounds = {
    min: [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)] as [number, number, number],
    max: [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)] as [number, number, number],
  };

  let count = legacyCount;
  let evlrOffset = 0;
  let evlrCount = 0;
  if (versionMinor >= 4 && buf.byteLength >= 375) {
    const big = dv.getBigInt64(247, true);
    count = legacyCount === 0 ? Number(big) : legacyCount;
    evlrOffset = Number(dv.getBigUint64(235, true));
    evlrCount = dv.getUint32(243, true);
  }

  const hasColor = pointFormat === 2 || pointFormat === 3 || pointFormat === 5 ||
    pointFormat === 7 || pointFormat === 8 || pointFormat === 10;
  const hasGps = pointFormat === 1 || pointFormat === 3 || pointFormat === 4 || pointFormat === 5 ||
    pointFormat >= 6;
  const hasNir = pointFormat === 8 || pointFormat === 10;

  return {
    versionMajor, versionMinor, headerSize, offsetToPoints, numVLR,
    pointFormat, pointLength, legacyCount, count, scale, offset, bounds,
    globalEncoding, hasColor, hasGps, hasNir, evlrOffset, evlrCount,
  };
}

function readCString(u8: Uint8Array, from: number, max: number): string {
  let s = '';
  for (let i = from; i < from + max && i < u8.length; i++) {
    const c = u8[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Scan VLRs (and EVLRs) for extra-byte definitions and CRS metadata. */
export function parseVLRs(buf: ArrayBuffer, h: LasHeader): { extra: ExtraByteDef[]; crs: string } {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const extra: ExtraByteDef[] = [];
  let crs = '';

  const scan = (base: number, extended: boolean) => {
    for (let v = 0; v < h.numVLR; v++) {
      const p = base + v * 54;
      if (p + 54 > buf.byteLength) break;
      const reserved = dv.getUint16(p, true);
      const userId = readCString(u8, p + 2, 16);
      const recordId = dv.getUint16(p + 18, true);
      const recLen = dv.getUint16(p + 20, true);
      const dataStart = p + 54;
      if (dataStart + recLen > buf.byteLength) break;

      if (userId.trim() === 'LASF_Spec' && recordId === 4) {
        const n = Math.floor(recLen / 192);
        for (let e = 0; e < n; e++) {
          const q = dataStart + e * 192;
          const dataType = u8[q + 2];
          const name = readCString(u8, q + 4, 32);
          const description = readCString(u8, q + 160, 32);
          const def = EXTRA_TYPES[dataType];
          if (!def || !name) continue;
          extra.push({
            name,
            dataType,
            size: def.size,
            kind: def.kind,
            offset: -1, // filled in later, relative to the extra-byte block
            description,
            noData: dv.getFloat64(q + 40, true),
          });
        }
      } else if (recordId === 34737) {
        crs = readCString(u8, dataStart, recLen).split('\0')[0];
      }
      void reserved;
      void extended;
    }
  };

  scan(h.headerSize, false);
  if (h.evlrOffset > 0 && h.evlrCount > 0) {
    // EVLR header is 60 bytes (record length is uint64).
    let p = h.evlrOffset;
    for (let v = 0; v < h.evlrCount; v++) {
      if (p + 60 > buf.byteLength) break;
      const userId = readCString(u8, p + 2, 16);
      const recordId = dv.getUint16(p + 18, true);
      const recLen = Number(dv.getBigUint64(p + 20, true));
      const dataStart = p + 60;
      if (userId.trim() === 'LASF_Spec' && recordId === 4 && dataStart + recLen <= buf.byteLength) {
        const n = Math.floor(recLen / 192);
        for (let e = 0; e < n; e++) {
          const q = dataStart + e * 192;
          const dataType = u8[q + 2];
          const name = readCString(u8, q + 4, 32);
          const def = EXTRA_TYPES[dataType];
          if (!def || !name) continue;
          extra.push({
            name, dataType,
            size: def.size,
            kind: def.kind,
            offset: -1,
            description: readCString(u8, q + 160, 32),
            noData: dv.getFloat64(q + 40, true),
          });
        }
      }
      p = dataStart + recLen;
    }
  }
  return { extra, crs };
}

/* ────────── point record decoding ────────── */

interface LasTargets {
  positions: Float32Array;
  intensity: Float32Array | null;
  classification: Float32Array | null;
  returnNumber: Float32Array | null;
  numberOfReturns: Float32Array | null;
  scanAngle: Float32Array | null;
  gps: Float32Array | null;
  userData: Float32Array | null;
  pointSource: Float32Array | null;
  rgb: Uint16Array | null;
  nir: Float32Array | null;
  extras: Map<string, Float32Array>;
}

export function decodePoints(
  dv: DataView,
  start: number,
  count: number,
  h: LasHeader,
  extraDefs: ExtraByteDef[],
  targets: LasTargets,
  onProgress?: ProgressFn,
  label = t('io.prog.lasParseRec')
): Promise<{ maxR: number; maxG: number; maxB: number }> {
  const pf = h.pointFormat;
  const stride = h.pointLength;
  const sx = h.scale[0], sy = h.scale[1], sz = h.scale[2];
  const ox = h.offset[0], oy = h.offset[1], oz = h.offset[2];
  const isNew = pf >= 6;

  const stdLength = isNew ? (NEW_LENGTH[pf] ?? 30) : (LEGACY_LENGTH[pf] ?? 20);
  const extraBlock = Math.max(0, stride - stdLength);
  const extraOffset = stdLength;

  const gpsOff = isNew ? 22 : (pf === 1 || pf === 3 || pf === 4 || pf === 5 ? 20 : -1);
  const rgbOff = isNew
    ? (pf === 7 || pf === 8 || pf === 10 ? 30 : -1)
    : (pf === 2 ? 20 : pf === 3 || pf === 5 ? 28 : -1);
  const nirOff = isNew ? (pf === 8 || pf === 10 ? 36 : -1) : -1;
  const angleOff = isNew ? 18 : 16;
  const classOff = isNew ? 16 : 15;
  const userOff = 17;
  const srcOff = isNew ? 20 : 18;

  let maxR = 0, maxG = 0, maxB = 0;

  return (async () => {
    for (let i = 0; i < count; i++) {
      const p = start + i * stride;
      if (p + stride > dv.byteLength) break;

      const rx = dv.getInt32(p, true);
      const ry = dv.getInt32(p + 4, true);
      const rz = dv.getInt32(p + 8, true);
      targets.positions[i * 3] = rx * sx + ox;
      targets.positions[i * 3 + 1] = ry * sy + oy;
      targets.positions[i * 3 + 2] = rz * sz + oz;

      if (targets.intensity) targets.intensity[i] = dv.getUint16(p + 12, true);

      const flags = dv.getUint8(p + 14);
      if (targets.returnNumber) targets.returnNumber[i] = flags & 0x0f;
      if (targets.numberOfReturns) targets.numberOfReturns[i] = (flags >> 4) & 0x0f;

      if (targets.classification) {
        const raw = dv.getUint8(p + classOff);
        targets.classification[i] = isNew ? raw : raw & 0x1f;
      }
      if (targets.scanAngle) {
        targets.scanAngle[i] = isNew ? dv.getInt16(p + angleOff, true) : dv.getInt8(p + angleOff);
      }
      if (targets.userData) targets.userData[i] = dv.getUint8(p + userOff);
      if (targets.pointSource) targets.pointSource[i] = dv.getUint16(p + srcOff, true);
      if (targets.gps && gpsOff >= 0) targets.gps[i] = dv.getFloat64(p + gpsOff, true);

      if (targets.rgb && rgbOff >= 0) {
        const r = dv.getUint16(p + rgbOff, true);
        const g = dv.getUint16(p + rgbOff + 2, true);
        const b = dv.getUint16(p + rgbOff + 4, true);
        targets.rgb[i * 3] = r;
        targets.rgb[i * 3 + 1] = g;
        targets.rgb[i * 3 + 2] = b;
        if (r > maxR) maxR = r;
        if (g > maxG) maxG = g;
        if (b > maxB) maxB = b;
      }
      if (targets.nir && nirOff >= 0) targets.nir[i] = dv.getUint16(p + nirOff, true);

      if (extraDefs.length && extraBlock > 0) {
        let eo = p + extraOffset;
        for (const def of extraDefs) {
          const arr = targets.extras.get(def.name);
          let v = NaN;
          switch (def.kind) {
            case 'u':
              v = def.size === 1 ? dv.getUint8(eo) : def.size === 2 ? dv.getUint16(eo, true) : dv.getUint32(eo, true);
              break;
            case 'i':
              v = def.size === 1 ? dv.getInt8(eo) : def.size === 2 ? dv.getInt16(eo, true) : dv.getInt32(eo, true);
              break;
            default:
              v = def.size === 8 ? dv.getFloat64(eo, true) : dv.getFloat32(eo, true);
          }
          if (arr) arr[i] = v;
          eo += def.size;
        }
      }

      if ((i & 0x1fffff) === 0 && i > 0) {
        onProgress?.(0.2 + 0.7 * (i / count), `${label} ${i.toLocaleString()}`);
        await yieldUI();
      }
    }
    return { maxR, maxG, maxB };
  })();
}

/* ────────── shared tail: build the cloud ────────── */

export function buildLasCloud(
  file: File,
  h: LasHeader,
  extraDefs: ExtraByteDef[],
  decode: (targets: LasTargets) => Promise<{ maxR: number; maxG: number; maxB: number }>,
  extraWarnings: string[]
): Promise<ParseOutcome> {
  const n = h.count;
  const warnings = [...extraWarnings];

  const positions = new Float32Array(n * 3);
  const intensity = new Float32Array(n);
  const classification = new Float32Array(n);
  const returnNumber = new Float32Array(n);
  const numberOfReturns = new Float32Array(n);
  const scanAngle = new Float32Array(n);
  const gps = h.hasGps ? new Float32Array(n) : null;
  const userData = new Float32Array(n);
  const pointSource = new Float32Array(n);
  const rgb = h.hasColor ? new Uint16Array(n * 3) : null;
  const nir = h.hasNir ? new Float32Array(n) : null;

  const extras = new Map<string, Float32Array>();
  const units = new Map<string, string>();
  for (const d of extraDefs) {
    extras.set(d.name, new Float32Array(n));
    const nm = d.name.toLowerCase();
    if (/temp|温度/.test(nm)) units.set(d.name, '°C');
    else if (/deform|位移|沉降/.test(nm)) units.set(d.name, 'mm');
  }

  const targets: LasTargets = {
    positions, intensity, classification, returnNumber, numberOfReturns,
    scanAngle, gps, userData, pointSource, rgb, nir, extras,
  };

  return decode(targets).then(({ maxR, maxG, maxB }) => {
    const scalars = new Map<string, Float32Array>();
    const scalarOrder: string[] = [];
    const add = (name: string, arr: Float32Array) => {
      scalars.set(name, arr);
      scalarOrder.push(name);
    };
    add('intensity', intensity);
    add('classification', classification);
    add('return_number', returnNumber);
    add('number_of_returns', numberOfReturns);
    add('scan_angle', scanAngle);
    add('user_data', userData);
    add('point_source_id', pointSource);
    if (gps) add('gps_time', gps);
    if (nir) add('nir', nir);
    for (const d of extraDefs) {
      const arr = extras.get(d.name);
      if (arr) add(d.name, arr);
    }

    let colors: Uint8Array | null = null;
    if (rgb) {
      colors = new Uint8Array(n * 3);
      const peak = Math.max(maxR, maxG, maxB);
      const shift = peak > 255 ? 1 / (peak / 255) : 1;
      for (let i = 0; i < n * 3; i++) {
        const v = rgb[i] * shift;
        colors[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      if (peak === 0) warnings.push(t('io.warn.lasRgbZero'));
    }

    if (extraDefs.length === 0) {
      const stdLength = h.pointFormat >= 6 ? (NEW_LENGTH[h.pointFormat] ?? 30) : (LEGACY_LENGTH[h.pointFormat] ?? 20);
      if (h.pointLength > stdLength) {
        warnings.push(
          t('io.warn.lasExtraIgnored', { p: h.pointLength, f: h.pointFormat, s: stdLength, d: h.pointLength - stdLength })
        );
      }
    }

    const data: PointCloudData = finishCloud(
      {
        count: n,
        positions,
        colors,
        scalars,
        scalarOrder,
        units,
        warnings,
        meta: {
          [tMeta('版本')]: `${h.versionMajor}.${h.versionMinor}`,
          [tMeta('点格式')]: String(h.pointFormat),
          [tMeta('点记录长度')]: `${h.pointLength} B`,
          [tMeta('缩放')]: h.scale.map((v) => v.toExponential(2)).join(' / '),
          [tMeta('偏移')]: h.offset.map((v) => v.toFixed(2)).join(' / '),
          [tMeta('头长度')]: `${h.headerSize} B`,
        },
      },
      file.name,
      'LAS'
    );
    return { data, warnings };
  });
}

/* ────────── public entry points ────────── */

export async function parseLAS(file: File, onProgress?: ProgressFn): Promise<ParseOutcome> {
  onProgress?.(0.05, t('io.prog.readFile'));
  const buf = await file.arrayBuffer();
  const h = parseLasHeader(buf);
  onProgress?.(0.12, t('io.prog.parseVlr'));

  if (h.count <= 0) throw new Error(t('io.err.lasZeroPts'));
  const expectedBytes = h.count * h.pointLength;
  if (h.offsetToPoints + expectedBytes > buf.byteLength) {
    const usable = Math.floor((buf.byteLength - h.offsetToPoints) / h.pointLength);
    if (usable <= 0) throw new Error(t('io.err.lasDataOverflow'));
  }

  const { extra, crs } = parseVLRs(buf, h);
  const stdLength = h.pointFormat >= 6 ? (NEW_LENGTH[h.pointFormat] ?? 30) : (LEGACY_LENGTH[h.pointFormat] ?? 20);
  const extraBlock = Math.max(0, h.pointLength - stdLength);

  // Lay out extra-byte offsets sequentially inside the extra block.
  const extraDefs: ExtraByteDef[] = [];
  let cursor = 0;
  for (const d of extra) {
    if (cursor + d.size > extraBlock) break;
    extraDefs.push({ ...d, offset: cursor });
    cursor += d.size;
  }

  if (crs) {
    // attach via meta later
  }

  const warnings: string[] = [];
  if (extra.length > extraDefs.length) {
    warnings.push(t('io.warn.lasExtraTrunc', { a: extraDefs.length, b: extra.length }));
  }
  const usable = Math.min(
    h.count,
    Math.max(0, Math.floor((buf.byteLength - h.offsetToPoints) / h.pointLength))
  );
  if (usable < h.count) {
    warnings.push(t('io.warn.lasTruncRead', { c: h.count.toLocaleString(), u: usable.toLocaleString() }));
  }

  const dv = new DataView(buf);
  const out = await buildLasCloud(
    file,
    { ...h, count: usable },
    extraDefs,
    (targets) => decodePoints(dv, h.offsetToPoints, usable, h, extraDefs, targets, onProgress),
    warnings
  );
  if (crs) out.data.meta[tMeta('坐标系')] = crs;
  onProgress?.(1, t('io.prog.done'));
  return out;
}

export async function parseLAZ(file: File, onProgress?: ProgressFn): Promise<ParseOutcome> {
  onProgress?.(0.03, t('io.prog.readFile'));
  const buf = await file.arrayBuffer();
  const h = parseLasHeader(buf);
  if (h.count <= 0) throw new Error(t('io.err.lazZeroPts'));

  onProgress?.(0.1, t('io.prog.parseVlr'));
  const { extra, crs } = parseVLRs(buf, h);
  const stdLength = h.pointFormat >= 6 ? (NEW_LENGTH[h.pointFormat] ?? 30) : (LEGACY_LENGTH[h.pointFormat] ?? 20);
  const extraBlock = Math.max(0, h.pointLength - stdLength);
  const extraDefs: ExtraByteDef[] = [];
  let cursor = 0;
  for (const d of extra) {
    if (cursor + d.size > extraBlock) break;
    extraDefs.push({ ...d, offset: cursor });
    cursor += d.size;
  }

  onProgress?.(0.16, t('io.prog.lazDecoder'));
  await yieldUI();
  const { decompressLaz } = await import('./laz');
  const body = await decompressLaz(buf, onProgress);
  onProgress?.(0.6, t('io.prog.lazDecompress'));
  await yieldUI();

  const dv = new DataView(body);
  const stride = h.pointLength;
  const usable = Math.min(h.count, Math.floor(body.byteLength / stride));
  const warnings: string[] = [t('io.warn.lazWasm')];
  if (usable < h.count) {
    warnings.push(t('io.warn.lazTrunc', { u: usable.toLocaleString(), c: h.count.toLocaleString() }));
  }

  const out = await buildLasCloud(
    file,
    { ...h, count: usable },
    extraDefs,
    (targets) => decodePoints(dv, 0, usable, h, extraDefs, targets, (r, l) => onProgress?.(0.6 + 0.35 * r, l)),
    warnings
  );
  if (crs) out.data.meta[tMeta('坐标系')] = crs;
  onProgress?.(1, t('io.prog.done'));
  return out;
}
