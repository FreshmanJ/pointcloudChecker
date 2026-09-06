/**
 * PLY reader — ascii, binary_little_endian and binary_big_endian.
 * List properties inside the vertex element are skipped correctly.
 */

import type { PointCloudData } from '../core/cloud';
import { t, tMeta } from '../i18n';
import { finishCloud, yieldUI, type ProgressFn } from './common';
import type { ParseOutcome } from './common';

type PlyType =
  | 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double'
  | 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const TYPE_SIZE: Record<PlyType, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

const TYPE_SIGNED: Record<PlyType, boolean> = {
  char: true, int8: true, uchar: false, uint8: false,
  short: true, int16: true, ushort: false, uint16: false,
  int: true, int32: true, uint: false, uint32: false,
  float: true, float32: true, double: true, float64: true,
};

const TYPE_FLOAT: Record<PlyType, boolean> = {
  char: false, int8: false, uchar: false, uint8: false,
  short: false, int16: false, ushort: false, uint16: false,
  int: false, int32: false, uint: false, uint32: false,
  float: true, float32: true, double: true, float64: true,
};

interface PlyProp {
  name: string;
  type: PlyType;
  isList: boolean;
  countType?: PlyType;
  offset: number;
}

const COORD = { x: 0, y: 1, z: 2 };
const COLOR = { red: 0, green: 1, blue: 2, diffuse_red: 0, diffuse_green: 1, diffuse_blue: 2, r: 0, g: 1, b: 2 };

export async function parsePLY(file: File, onProgress?: ProgressFn): Promise<ParseOutcome> {
  const buf = await file.arrayBuffer();
  const warnings: string[] = [];
  const u8 = new Uint8Array(buf);

  /* ────────── header ────────── */
  let cursor = 0;
  const readLine = (): string => {
    let start = cursor;
    while (cursor < u8.length && u8[cursor] !== 10) cursor++;
    let end = cursor;
    if (end > start && u8[end - 1] === 13) end--;
    cursor++;
    return new TextDecoder('utf-8').decode(u8.subarray(start, end));
  };

  const magic = readLine().trim();
  if (magic !== 'ply' && magic !== 'PLY') throw new Error(t('io.err.plyMagic'));

  let format = 'ascii';
  let vertexCount = 0;
  let vertexProps: PlyProp[] = [];
  let inVertex = false;
  const otherElements: { name: string; count: number }[] = [];
  let currentElement = '';
  let vertexStride = 0;

  for (let guard = 0; guard < 4096; guard++) {
    const line = readLine().trim();
    if (!line) continue;
    if (line === 'end_header') break;
    const parts = line.split(/\s+/);
    const kw = parts[0];

    if (kw === 'format') {
      format = (parts[1] || 'ascii').toLowerCase();
    } else if (kw === 'element') {
      currentElement = parts[1] || '';
      const count = Number(parts[2]) || 0;
      if (currentElement === 'vertex') {
        vertexCount = count;
        inVertex = true;
        vertexProps = [];
        vertexStride = 0;
      } else {
        inVertex = false;
        otherElements.push({ name: currentElement, count });
      }
    } else if (kw === 'property' && inVertex) {
      if (parts[1] === 'list') {
        vertexProps.push({
          name: parts[4] || 'list',
          type: (parts[3] || 'uchar') as PlyType,
          isList: true,
          countType: (parts[2] || 'uchar') as PlyType,
          offset: vertexStride,
        });
      } else {
        const type = (parts[1] || 'float') as PlyType;
        vertexProps.push({ name: parts[2] || '', type, isList: false, offset: vertexStride });
        vertexStride += TYPE_SIZE[type] ?? 4;
      }
    } else if (kw === 'comment' || kw === 'obj_info') {
      // ignore
    }
  }

  if (vertexCount <= 0) throw new Error(t('io.err.plyNoVertex'));
  if (format !== 'ascii' && !/^binary_(little|big)_endian$/.test(format)) {
    warnings.push(t('io.warn.plyFmt', { f: format }));
  }
  const little = format !== 'binary_big_endian';

  const xi = vertexProps.findIndex((p) => !p.isList && p.name.toLowerCase() === 'x');
  const yi = vertexProps.findIndex((p) => !p.isList && p.name.toLowerCase() === 'y');
  const zi = vertexProps.findIndex((p) => !p.isList && p.name.toLowerCase() === 'z');
  if (xi < 0 || yi < 0 || zi < 0) throw new Error(t('io.err.plyNoXYZ'));

  const findColor = (c: 0 | 1 | 2): number => {
    for (const key of Object.keys(COLOR)) {
      if ((COLOR as Record<string, number>)[key] !== c) continue;
      const i = vertexProps.findIndex((p) => !p.isList && p.name.toLowerCase() === key);
      if (i >= 0) return i;
    }
    return -1;
  };
  const rIdx = findColor(0);
  const gIdx = findColor(1);
  const bIdx = findColor(2);
  const hasColor = rIdx >= 0 && gIdx >= 0 && bIdx >= 0;

  const positions = new Float32Array(vertexCount * 3);
  const colors = hasColor ? new Uint8Array(vertexCount * 3) : null;

  const reserved = new Set([xi, yi, zi, rIdx, gIdx, bIdx]);
  const scalars = new Map<string, Float32Array>();
  const scalarOrder: string[] = [];
  vertexProps.forEach((p, i) => {
    if (p.isList || reserved.has(i)) return;
    const ln = p.name.toLowerCase();
    if (ln in COORD || ln in COLOR) return;
    if (scalars.has(p.name)) return;
    scalars.set(p.name, new Float32Array(vertexCount));
    scalarOrder.push(p.name);
  });

  let pt = 0;
  function assign(vals: number[]): void {
    if (pt >= vertexCount) return;
    positions[pt * 3] = vals[xi];
    positions[pt * 3 + 1] = vals[yi];
    positions[pt * 3 + 2] = vals[zi];
    if (colors) {
      colors[pt * 3] = clamp255(vals[rIdx]);
      colors[pt * 3 + 1] = clamp255(vals[gIdx]);
      colors[pt * 3 + 2] = clamp255(vals[bIdx]);
    }
    let vi = 0;
    for (const prop of vertexProps) {
      if (prop.isList) continue;
      const arr = scalars.get(prop.name);
      if (arr) arr[pt] = vals[vi];
      vi++;
    }
    pt++;
  }

  /* ────────── body ────────── */
  onProgress?.(0.2, t('io.prog.plyVertex', { n: vertexCount.toLocaleString() }));
  await yieldUI();

  if (format === 'ascii') {
    const text = new TextDecoder('utf-8').decode(u8.subarray(cursor));
    const lines = text.split('\n');
    let p = 0;
    for (let li = 0; li < lines.length && p < vertexCount; li++) {
      const line = lines[li].trim();
      if (!line) continue;
      const toks = line.split(/\s+/);
      let tok = 0;
      const vals: number[] = [];
      for (const prop of vertexProps) {
        if (prop.isList) {
          const n = Number(toks[tok++]) || 0;
          tok += n;
          continue;
        }
        vals.push(Number(toks[tok++]));
      }
      assign(vals);
      p++;
      if ((p & 0x7ffff) === 0) {
        onProgress?.(0.2 + 0.7 * (li / lines.length), t('io.prog.plyAscii', { n: p.toLocaleString() }));
        await yieldUI();
      }
    }
  } else {
    const dv = new DataView(buf);
    let byteOffset = cursor;
    const maxPoints = Math.min(
      vertexCount,
      Math.max(0, Math.floor((u8.length - cursor) / Math.max(1, vertexStride)))
    );
    if (maxPoints < vertexCount) {
      warnings.push(
        t('io.warn.plyTrunc', { v: vertexCount.toLocaleString(), m: maxPoints.toLocaleString() })
      );
    }
    const vals: number[] = new Array(vertexProps.filter((p) => !p.isList).length).fill(0);

    for (let i = 0; i < maxPoints; i++) {
      let vi = 0;
      let local = byteOffset;
      for (const prop of vertexProps) {
        if (prop.isList) {
          const cntType = prop.countType ?? 'uchar';
          const n = readBin(dv, local, cntType, little);
          local += TYPE_SIZE[cntType] ?? 1;
          local += n * (TYPE_SIZE[prop.type] ?? 1);
          continue;
        }
        vals[vi++] = readBin(dv, local, prop.type, little);
        local += TYPE_SIZE[prop.type] ?? 4;
      }
      assign(vals);
      byteOffset = local;
      if ((i & 0xfffff) === 0 && i > 0) {
        onProgress?.(0.2 + 0.7 * (i / maxPoints), t('io.prog.plyBinary', { n: i.toLocaleString() }));
        await yieldUI();
      }
    }
    vertexCount = maxPoints;
  }

  if (otherElements.length) {
    warnings.push(t('io.warn.plyIgnore', { list: otherElements.map((e) => `${e.name}(${e.count})`).join('、') }));
  }

  const data: PointCloudData = finishCloud(
    {
      count: vertexCount,
      positions,
      colors,
      scalars,
      scalarOrder,
      warnings,
      meta: {
        [tMeta('属性')]: vertexProps.filter((p) => !p.isList).map((p) => p.name).join(' '),
        [tMeta('编码')]: format,
      },
    },
    file.name,
    'PLY'
  );
  onProgress?.(1, t('io.prog.done'));
  return { data, warnings };
}

function readBin(dv: DataView, off: number, type: PlyType, little: boolean): number {
  const size = TYPE_SIZE[type] ?? 4;
  if (off + size > dv.byteLength) return NaN;
  if (TYPE_FLOAT[type]) return size === 8 ? dv.getFloat64(off, little) : dv.getFloat32(off, little);
  if (size === 1) return TYPE_SIGNED[type] ? dv.getInt8(off) : dv.getUint8(off);
  if (size === 2) return TYPE_SIGNED[type] ? dv.getInt16(off, little) : dv.getUint16(off, little);
  return TYPE_SIGNED[type] ? dv.getInt32(off, little) : dv.getUint32(off, little);
}

function clamp255(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
