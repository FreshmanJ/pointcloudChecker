/**
 * PCD reader — ascii, binary and binary_compressed (LZF).
 */

import type { PointCloudData } from '../core/cloud';
import { t, tMeta } from '../i18n';
import { finishCloud, yieldUI, type ProgressFn } from './common';
import type { ParseOutcome } from './common';

interface PcdField {
  name: string;
  size: number;
  type: 'I' | 'U' | 'F';
  count: number;
  offset: number;
}

export async function parsePCD(file: File, onProgress?: ProgressFn): Promise<ParseOutcome> {
  const buf = await file.arrayBuffer();
  const warnings: string[] = [];

  /* ────────── header ────────── */
  const headLen = Math.min(buf.byteLength, 1 << 20);
  const headText = new TextDecoder('utf-8').decode(new Uint8Array(buf, 0, headLen));
  const dataIdx = headText.search(/\nDATA\s/i);
  if (dataIdx < 0) throw new Error(t('io.err.pcdNoData'));
  const lineEnd = headText.indexOf('\n', dataIdx + 1);
  const dataMode = headText
    .slice(dataIdx + 6, lineEnd < 0 ? headText.length : lineEnd)
    .trim()
    .toLowerCase();
  const dataOffset = dataIdx + 1 + (lineEnd < 0 ? headText.length - dataIdx - 1 : lineEnd - dataIdx);

  let names: string[] = [];
  let sizes: number[] = [];
  let types: string[] = [];
  let counts: number[] = [];
  let width = 0;
  let height = 0;
  let points = 0;

  for (const rawLine of headText.slice(0, dataIdx).split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sp = line.search(/[\s]/);
    const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const val = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (key) {
      case 'FIELDS': names = val.split(/\s+/).filter(Boolean); break;
      case 'SIZE': sizes = val.split(/\s+/).map(Number); break;
      case 'TYPE': types = val.split(/\s+/); break;
      case 'COUNT': counts = val.split(/\s+/).map(Number); break;
      case 'WIDTH': width = Number(val); break;
      case 'HEIGHT': height = Number(val); break;
      case 'POINTS': points = Number(val); break;
      default: break;
    }
  }
  if (names.length === 0) throw new Error(t('io.err.pcdNoFields'));
  if (!Number.isFinite(points) || points <= 0) points = width * Math.max(1, height);
  if (!Number.isFinite(points) || points <= 0) {
    throw new Error(t('io.err.pcdBadCount'));
  }

  const fields: PcdField[] = [];
  let off = 0;
  for (let i = 0; i < names.length; i++) {
    const size = Number.isFinite(sizes[i]) && sizes[i] > 0 ? sizes[i] : 4;
    const type = ((types[i] || 'F').toUpperCase().charAt(0) as 'I' | 'U' | 'F');
    const count = Number.isFinite(counts[i]) && counts[i] > 0 ? counts[i] : 1;
    fields.push({ name: names[i], size, type, count, offset: off });
    off += size * count;
    if (count > 1) warnings.push(t('io.warn.pcdSkipDim', { n: names[i], c: count }));
  }
  const stride = off;

  const xi = fields.findIndex((f) => f.name.toLowerCase() === 'x');
  const yi = fields.findIndex((f) => f.name.toLowerCase() === 'y');
  const zi = fields.findIndex((f) => f.name.toLowerCase() === 'z');
  if (xi < 0 || yi < 0 || zi < 0) throw new Error(t('io.err.pcdNoXYZ'));

  const positions = new Float32Array(points * 3);
  const rgbIndex = fields.findIndex((f) => /^(rgb|rgba)$/i.test(f.name));
  const rIndex = fields.findIndex((f) => /^(r|red|diffuse_red)$/i.test(f.name));
  const gIndex = fields.findIndex((f) => /^(g|green|diffuse_green)$/i.test(f.name));
  const bIndex = fields.findIndex((f) => /^(b|blue|diffuse_blue)$/i.test(f.name));

  let colors: Uint8Array | null = null;
  if (rgbIndex >= 0 || (rIndex >= 0 && gIndex >= 0 && bIndex >= 0)) {
    colors = new Uint8Array(points * 3);
  }

  const reserved = new Set([xi, yi, zi, rgbIndex, rIndex, gIndex, bIndex]);
  const scalars = new Map<string, Float32Array>();
  const scalarOrder: string[] = [];
  for (const f of fields) {
    if (f.count !== 1) continue;
    if (reserved.has(fields.indexOf(f))) continue;
    if (scalars.has(f.name)) continue;
    scalars.set(f.name, new Float32Array(points));
    scalarOrder.push(f.name);
  }

  let pt = 0;

  function store(fi: number, v: number): void {
    if (pt >= points) return;
    const f = fields[fi];
    if (fi === xi) { positions[pt * 3] = v; return; }
    if (fi === yi) { positions[pt * 3 + 1] = v; return; }
    if (fi === zi) { positions[pt * 3 + 2] = v; return; }
    if (colors) {
      if (fi === rgbIndex) {
        const packed = v >>> 0;
        colors[pt * 3] = (packed >> 16) & 255;
        colors[pt * 3 + 1] = (packed >> 8) & 255;
        colors[pt * 3 + 2] = packed & 255;
        return;
      }
      if (fi === rIndex) { colors[pt * 3] = clamp255(v); return; }
      if (fi === gIndex) { colors[pt * 3 + 1] = clamp255(v); return; }
      if (fi === bIndex) { colors[pt * 3 + 2] = clamp255(v); return; }
    }
    const arr = scalars.get(f.name);
    if (arr) arr[pt] = v;
  }

  /* ────────── ascii ────────── */
  if (dataMode === 'ascii') {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(buf, dataOffset));
    const lines = text.split('\n');
    for (let li = 0; li < lines.length && pt < points; li++) {
      const line = lines[li].trim();
      if (!line || line.startsWith('#')) continue;
      const toks = line.split(/\s+/);
      let tok = 0;
      for (let fi = 0; fi < fields.length; fi++) {
        const f = fields[fi];
        for (let c = 0; c < f.count; c++) {
          const v = Number(toks[tok++]);
          if (c === 0) store(fi, v);
        }
      }
      pt++;
      if ((pt & 0x3ffff) === 0) {
        onProgress?.(0.2 + 0.7 * (li / lines.length), t('io.prog.pcdAscii', { n: pt.toLocaleString() }));
        await yieldUI();
      }
    }
  } else {
    /* ────────── binary / binary_compressed ────────── */
    let body: ArrayBuffer;
    if (dataMode === 'binary_compressed') {
      onProgress?.(0.15, t('io.prog.pcdLzf'));
      await yieldUI();
      const dv0 = new DataView(buf, dataOffset);
      const compSize = dv0.getUint32(0, true);
      const uncompSize = dv0.getUint32(4, true);
      const out = new Uint8Array(uncompSize);
      lzfDecompress(new Uint8Array(buf, dataOffset + 8, Math.min(compSize, buf.byteLength - dataOffset - 8)), compSize, out, uncompSize);
      body = out.buffer;
      warnings.push(t('io.warn.pcdLzf'));
    } else if (dataMode === 'binary') {
      body = buf;
      off = dataOffset;
    } else {
      throw new Error(t('io.err.pcdDataType', { m: dataMode }));
    }

    const dv = new DataView(body);
    const base0 = dataMode === 'binary' ? dataOffset : 0;
    const available = body.byteLength - base0;
    const usable = Math.min(points, Math.floor(available / stride));
    if (usable < points) {
      warnings.push(
        t('io.err.pcdTrunc', { e: (stride * points).toLocaleString(), a: available.toLocaleString(), u: usable.toLocaleString() })
      );
    }
    for (let i = 0; i < usable; i++) {
      const base = base0 + i * stride;
      for (let fi = 0; fi < fields.length; fi++) {
        const f = fields[fi];
        store(fi, readField(dv, base + f.offset, f.type, f.size));
      }
      pt++;
      if ((i & 0xfffff) === 0 && i > 0) {
        onProgress?.(0.2 + 0.7 * (i / usable), t('io.prog.pcdBinary', { n: i.toLocaleString() }));
        await yieldUI();
      }
    }
  }

  const data: PointCloudData = finishCloud(
    {
      count: pt,
      positions: positions.subarray(0, pt * 3),
      colors: colors ? colors.subarray(0, pt * 3) : null,
      scalars: trimScalars(scalars, pt),
      scalarOrder,
      warnings,
      meta: { [tMeta('字段')]: fields.map((f) => f.name).join(' '), [tMeta('DATA')]: dataMode },
    },
    file.name,
    'PCD'
  );
  onProgress?.(1, t('io.prog.done'));
  return { data, warnings };
}

function trimScalars(map: Map<string, Float32Array>, n: number): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const [k, v] of map) out.set(k, v.subarray(0, n));
  return out;
}

export function readField(dv: DataView, offset: number, type: 'I' | 'U' | 'F', size: number): number {
  if (offset + size > dv.byteLength) return NaN;
  switch (type) {
    case 'F':
      return size === 8 ? dv.getFloat64(offset, true) : dv.getFloat32(offset, true);
    case 'I':
      if (size === 1) return dv.getInt8(offset);
      if (size === 2) return dv.getInt16(offset, true);
      return dv.getInt32(offset, true);
    case 'U':
    default:
      if (size === 1) return dv.getUint8(offset);
      if (size === 2) return dv.getUint16(offset, true);
      return dv.getUint32(offset, true);
  }
}

function clamp255(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * liblzf decompression — the exact variant used by PCL's binary_compressed.
 */
export function lzfDecompress(src: Uint8Array, srcLen: number, dst: Uint8Array, dstLen: number): number {
  let iIdx = 0;
  let oIdx = 0;
  while (iIdx < srcLen) {
    const ctrl = src[iIdx++];
    if (ctrl < 1 << 5) {
      let len = ctrl + 1;
      if (oIdx + len > dstLen) len = dstLen - oIdx;
      if (iIdx + len > srcLen) len = srcLen - iIdx;
      for (let i = 0; i < len; i++) dst[oIdx++] = src[iIdx++];
      if (oIdx >= dstLen) break;
    } else {
      let len = ctrl >> 5;
      let ref = oIdx - ((ctrl & 0x1f) << 8) - 1;
      if (len === 7) {
        if (iIdx < srcLen) len += src[iIdx++];
        if (iIdx < srcLen) ref -= src[iIdx++];
      } else if (iIdx < srcLen) {
        ref -= src[iIdx++];
      }
      if (ref < 0) break;
      len += 2;
      if (oIdx + len > dstLen) len = dstLen - oIdx;
      for (let i = 0; i < len; i++) dst[oIdx++] = dst[ref++];
    }
  }
  return oIdx;
}
