/**
 * Format detection + parse dispatch.
 */

import type { PointCloudData } from '../core/cloud';
import { extOf, type ColumnSelection, type ProgressFn } from './common';
import type { ParseOutcome } from './common';

/** Re-exported so callers can detect delimited-text formats without reaching
 *  into the `common` module directly. */
export { isTextColumnFormat } from './common';
export { extOf } from './common';

export interface FormatInfo {
  ext: string;
  label: string;
  note: string;
  binary?: boolean;
}

export const SUPPORTED_FORMATS: FormatInfo[] = [
  { ext: 'las', label: 'LAS', note: 'ASPRS 激光雷达标准 · 1.0–1.4', binary: true },
  { ext: 'laz', label: 'LAZ', note: 'LAS 的无损压缩格式', binary: true },
  { ext: 'pcd', label: 'PCD', note: 'PCL 点云格式 · ascii / binary / LZF', binary: true },
  { ext: 'ply', label: 'PLY', note: 'Polygon File Format（Stanford）', binary: true },
  { ext: 'pts', label: 'PTS', note: 'Leica 扫描仪文本点云' },
  { ext: 'ptx', label: 'PTX', note: '带位姿的文本点云' },
  { ext: 'xyz', label: 'XYZ', note: '纯坐标文本，可带属性列' },
  { ext: 'csv', label: 'CSV', note: '带表头的表格点云' },
  { ext: 'txt', label: 'TXT', note: '通用分隔文本' },
  { ext: 'obj', label: 'OBJ', note: 'Wavefront，仅取顶点' },
  { ext: 'bin', label: 'BIN', note: '原始 float32 三元组流', binary: true },
];

export const ACCEPT_ATTR = SUPPORTED_FORMATS.map((f) => `.${f.ext}`).join(',');

export function isSupported(name: string): boolean {
  const e = extOf(name);
  return SUPPORTED_FORMATS.some((f) => f.ext === e);
}

/** Peek at the first bytes to identify a file regardless of its extension. */
export function sniffFormat(file: File): Promise<string> {
  return file.slice(0, 512).arrayBuffer().then((buf) => {
    const u8 = new Uint8Array(buf);
    const head = String.fromCharCode(...u8.subarray(0, 4));
    if (head === 'LASF') return extOf(file.name) === 'laz' ? 'laz' : 'las';
    const text = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(0, 200));
    if (/^ply\s/.test(text)) return 'ply';
    if (/#\s*\.PCD|^\s*VERSION\s/i.test(text)) return 'pcd';
    if (/^\s*#?\s*[a-zA-Z_"'[]/.test(text) && /[,\t;]/.test(text)) return 'csv';
    const ext = extOf(file.name);
    if (SUPPORTED_FORMATS.some((f) => f.ext === ext)) return ext;
    // Fall back: does the first line look like numbers?
    const first = text.split('\n')[0] ?? '';
    return /^\s*[-+]?[\d.]/.test(first) ? 'xyz' : 'txt';
  });
}

export async function loadPointCloud(
  file: File,
  onProgress?: ProgressFn,
  selection: ColumnSelection | null = null
): Promise<ParseOutcome> {
  const ext = extOf(file.name);
  let format = ext;
  if (!SUPPORTED_FORMATS.some((f) => f.ext === ext)) {
    format = await sniffFormat(file);
    onProgress?.(0.02, `按内容识别为 ${format.toUpperCase()}`);
  }

  switch (format) {
    case 'las': {
      const { parseLAS } = await import('./las');
      return parseLAS(file, onProgress);
    }
    case 'laz': {
      const { parseLAZ } = await import('./las');
      return parseLAZ(file, onProgress);
    }
    case 'pcd': {
      const { parsePCD } = await import('./pcd');
      return parsePCD(file, onProgress);
    }
    case 'ply': {
      const { parsePLY } = await import('./ply');
      return parsePLY(file, onProgress);
    }
    case 'obj': {
      const { parseOBJ } = await import('./obj');
      return parseOBJ(file, onProgress);
    }
    case 'bin': {
      const { parseRawBinary } = await import('./raw');
      return parseRawBinary(file, onProgress);
    }
    case 'csv':
    case 'txt':
    case 'xyz':
    case 'xyzn':
    case 'pts':
    case 'ptx':
    default: {
      const { parseTextPoints } = await import('./text');
      return parseTextPoints(file, selection, onProgress);
    }
  }
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function describeCloud(data: PointCloudData): string {
  return `${data.name} · ${data.count.toLocaleString()} 点 · ${data.format}`;
}
