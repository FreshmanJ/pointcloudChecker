/**
 * Delimited text point clouds: XYZ / CSV / TXT / PTS / PTX.
 * Handles automatic delimiter detection, optional headers, decimal commas and
 * comment lines.
 *
 * For these formats the coordinate columns are not guaranteed to be the first
 * three, so `previewTextColumns` lets the UI ask the user which columns map to
 * X / Y (/ Z); `parseTextPoints` honours a `ColumnSelection` when provided.
 */

import type { PointCloudData } from '../core/cloud';
import {
  classifyColumn,
  detectDelimiter,
  extOf,
  finishCloud,
  isCommentLine,
  normalizeName,
  scanRow,
  splitHeaderTokens,
  yieldUI,
  type ColumnSelection,
  type ProgressFn,
  type TextColumnPreview,
} from './common';
import type { ParseOutcome } from './common';

interface ColumnPlan {
  kind: 'skip' | 'x' | 'y' | 'z' | 'r' | 'g' | 'b' | 'scalar';
  name: string;
  index: number;
}

interface HeaderInfo {
  startOffset: number;
  delim: number;
  hasHeader: boolean;
  headerTokens: string[];
  ncols: number;
  declaredCount: number;
}

/** Shared header / offset inspection used by both preview and parse. */
function inspectTextHeader(text: string, ext: string): HeaderInfo {
  let startOffset = 0;
  let declaredCount = -1;
  if (ext === 'ptx') {
    let line = 0;
    let i = 0;
    while (i < text.length && line < 7) {
      if (text.charCodeAt(i) === 10) line++;
      i++;
    }
    startOffset = i;
  } else if (ext === 'pts') {
    const nl = text.indexOf('\n');
    const first = text.slice(0, nl < 0 ? text.length : nl).trim();
    const v = Number(first);
    if (Number.isFinite(v) && v > 0 && !/\s/.test(first)) {
      declaredCount = Math.floor(v);
      startOffset = nl + 1;
    }
  }

  let probeStart = startOffset;
  while (probeStart < text.length) {
    let e = text.indexOf('\n', probeStart);
    if (e < 0) e = text.length;
    if (!isCommentLine(text, probeStart, e) && e > probeStart + 1) break;
    probeStart = e + 1;
  }
  let probeEnd = text.indexOf('\n', probeStart);
  if (probeEnd < 0) probeEnd = text.length;

  const delim = detectDelimiter(text, probeStart, probeEnd);
  const probeRow = new Float64Array(128);
  const probe = scanRow(text, probeStart, probeEnd, delim, probeRow);
  const hasHeader = probe.nonNumeric || probe.count === 0;
  const headerTokens = hasHeader ? splitHeaderTokens(text, probeStart, probeEnd, delim) : [];
  const ncols = Math.max(3, hasHeader ? headerTokens.length : probe.count);
  return { startOffset, delim, hasHeader, headerTokens, ncols, declaredCount };
}

/** Default X/Y/Z indices (auto-detect), reused for the dialog pre-selection. */
export function autoCoordIndices(ncols: number, headerTokens: string[], hasHeader: boolean): { x: number; y: number; z: number } {
  const taken = new Set<number>();
  let x = -1, y = -1, z = -1;
  if (hasHeader) {
    for (let c = 0; c < ncols; c++) {
      const k = classifyColumn(headerTokens[c] ?? '');
      if (k === 'x' && x < 0) { x = c; taken.add(c); }
      else if (k === 'y' && y < 0) { y = c; taken.add(c); }
      else if (k === 'z' && z < 0) { z = c; taken.add(c); }
    }
  }
  const firstFree = (after: number): number => {
    for (let c = 0; c < ncols; c++) if (!taken.has(c)) { taken.add(c); return c; }
    return after;
  };
  if (x < 0) x = firstFree(0);
  if (y < 0) y = firstFree(x);
  if (z < 0) z = firstFree(y);
  return { x, y, z };
}

/**
 * Read only enough of the file to show the coordinate-picking dialog:
 * column names, count, and a few sample values per column.
 */
export async function previewTextColumns(file: File): Promise<TextColumnPreview> {
  const ext = extOf(file.name);
  const text = await file.text();
  if (!text || text.trim().length === 0) throw new Error('文件为空');

  const head = inspectTextHeader(text, ext);
  const { startOffset, delim, hasHeader, headerTokens, ncols, declaredCount } = head;

  // Find the first data row to begin sampling.
  let dataStart = startOffset;
  while (dataStart < text.length) {
    let e = text.indexOf('\n', dataStart);
    if (e < 0) e = text.length;
    if (!isCommentLine(text, dataStart, e) && e > dataStart + 1) break;
    dataStart = e + 1;
  }
  if (hasHeader) {
    const nl = text.indexOf('\n', startOffset);
    dataStart = nl < 0 ? text.length : nl + 1;
  }

  const samples: number[][] = Array.from({ length: ncols }, () => []);
  // Count finite numbers per column over a larger sample so the dialog can flag
  // text columns (e.g. IDs/labels) that would otherwise yield a silent empty cloud.
  const valid = new Int32Array(ncols);
  // Keep the raw sampled rows so the dialog can predict, for ANY coordinate
  // selection, how many rows would actually parse (catches the case where X/Y/Z
  // each have some numbers but never on the same row).
  const sampleRows: number[][] = [];
  const buf = new Float64Array(ncols + 8);
  let i = dataStart;
  let scanned = 0;
  const MAX_PREVIEW_ROWS = 500;
  while (i < text.length && scanned < MAX_PREVIEW_ROWS) {
    let e = text.indexOf('\n', i);
    if (e < 0) e = text.length;
    if (e > i + 1 && !isCommentLine(text, i, e)) {
      const res = scanRow(text, i, e, delim, buf);
      if (res.count >= 1) {
        for (let c = 0; c < ncols; c++) {
          const v = c < res.count ? buf[c] : NaN;
          if (Number.isFinite(v)) {
            valid[c]++;
            if (samples[c].length < 3) samples[c].push(v);
          }
        }
        sampleRows.push(Array.from({ length: ncols }, (_, c) => (c < res.count ? buf[c] : NaN)));
        scanned++;
      }
    }
    i = e + 1;
  }

  const columns = Array.from({ length: ncols }, (_, c) => ({
    index: c,
    name: hasHeader && headerTokens[c] ? normalizeName(headerTokens[c]) : `列 ${c + 1}`,
    sample: samples[c],
    validCount: valid[c],
  }));

  return { ext, hasHeader, delim, sampledRows: scanned, columns, rows: sampleRows, declaredCount } as TextColumnPreview & { declaredCount: number };
}

export async function parseTextPoints(
  file: File,
  selection: ColumnSelection | null,
  onProgress?: ProgressFn
): Promise<ParseOutcome> {
  const ext = extOf(file.name);
  const warnings: string[] = [];
  onProgress?.(0.02, '读取文件…');
  const text = await file.text();
  if (!text || text.trim().length === 0) {
    throw new Error('文件为空');
  }

  const head = inspectTextHeader(text, ext);
  const { startOffset, delim, hasHeader, headerTokens, ncols, declaredCount } = head;

  // ── Build the column plan ──
  const plan: ColumnPlan[] = [];
  const used = { x: false, y: false, z: false, r: false, g: false, b: false };

  const coord =
    selection != null
      ? {
          x: selection.x,
          y: selection.y,
          z: selection.mode === '3d' ? selection.z : -1,
        }
      : autoCoordIndices(ncols, headerTokens, hasHeader);

  // Coordinate column indices into the parsed row buffer (zi === -1 in 2D).
  const xi = coord.x;
  const yi = coord.y;
  const zi = coord.z;

  for (let c = 0; c < ncols; c++) {
    let kind: ColumnPlan['kind'] = 'scalar';
    let name = hasHeader ? normalizeName(headerTokens[c] ?? '') : '';
    if (c === coord.x) { kind = 'x'; name = name || 'x'; used.x = true; }
    else if (c === coord.y) { kind = 'y'; name = name || 'y'; used.y = true; }
    else if (c === coord.z) { kind = 'z'; name = name || 'z'; used.z = true; }
    else if (hasHeader) {
      const k = classifyColumn(headerTokens[c] ?? '');
      if (k === 'r' && !used.r) { kind = 'r'; used.r = true; }
      else if (k === 'g' && !used.g) { kind = 'g'; used.g = true; }
      else if (k === 'b' && !used.b) { kind = 'b'; used.b = true; }
      else kind = 'scalar';
    }
    if (kind === 'scalar' && !name) name = `field_${c + 1}`;
    plan.push({ kind, name, index: c });
  }

  if (!used.x || !used.y || (selection?.mode !== '2d' && !used.z)) {
    // Last-resort fallback (should not happen with a valid selection).
    plan.forEach((p, i) => {
      if (!used.x && i === coord.x) { p.kind = 'x'; used.x = true; }
      else if (!used.y && i === coord.y) { p.kind = 'y'; used.y = true; }
      else if (!used.z && selection?.mode !== '2d' && i === coord.z) { p.kind = 'z'; used.z = true; }
    });
    if (ncols < 3 && selection?.mode === '3d') throw new Error('至少需要 3 列数值作为 X/Y/Z 坐标');
    warnings.push('坐标列映射异常，已按默认方式解释坐标。');
  }

  if (selection) {
    const zNote = selection.mode === '2d' ? '（二维，Z 固定为 0）' : '';
    warnings.push(`坐标列由用户指定：X=#${coord.x + 1} Y=#${coord.y + 1}` + (selection.mode === '3d' ? ` Z=#${coord.z + 1}` : '') + zNote);
  }

  // ── Count rows ──
  onProgress?.(0.1, '统计行数…');
  let lineCount = 0;
  let scanIdx = startOffset - 1;
  while ((scanIdx = text.indexOf('\n', scanIdx + 1)) >= 0) lineCount++;
  let capacity = declaredCount > 0 ? Math.min(declaredCount, lineCount + 1) : lineCount + 1;
  if (hasHeader) capacity = Math.max(1, capacity - 1);
  capacity = Math.max(1, capacity);

  const width = ncols;
  let raw = new Float32Array(capacity * width);
  let rows = 0;
  let dataRows = 0; // candidate rows (>=3 fields) seen
  let coordBad = 0; // candidate rows rejected for non-finite X/Y/Z
  const delimLabel = delim === 44 ? ',' : delim === 59 ? ';' : delim === 9 ? '\\t' : '空格';

  onProgress?.(0.18, '解析坐标…');
  const rowBuf = new Float64Array(width + 8);
  let i = startOffset;
  if (hasHeader) {
    const nl = text.indexOf('\n', startOffset);
    i = nl < 0 ? text.length : nl + 1;
  }
  let lastReport = 0;

  while (i < text.length) {
    let e = text.indexOf('\n', i);
    if (e < 0) e = text.length;
    const next = e + 1;
    if (e > i + 1 && !isCommentLine(text, i, e)) {
      const res = scanRow(text, i, e, delim, rowBuf);
      if (res.count >= 3) {
        dataRows++;
        // A row is usable only if its coordinate columns parsed to numbers.
        // Non-coordinate text columns (IDs, labels) are tolerated. When a row
        // fails, we just count it and move on — `i = next` below must always
        // run, so we must NOT `continue` here (that would skip the advance and
        // infinite-loop on a file whose chosen columns are all non-numeric).
        const xv = xi < res.count ? rowBuf[xi] : NaN;
        const yv = yi < res.count ? rowBuf[yi] : NaN;
        const zv = zi >= 0 && zi < res.count ? rowBuf[zi] : NaN;
        if (Number.isFinite(xv) && Number.isFinite(yv) && (zi < 0 || Number.isFinite(zv))) {
          if (rows >= capacity) {
            const grownCap = Math.max(capacity * 2, rows + 1024);
            const grown = new Float32Array(grownCap * width);
            grown.set(raw.subarray(0, rows * width));
            raw = grown;
            capacity = grownCap;
          }
          const base = rows * width;
          for (let c = 0; c < width; c++) {
            raw[base + c] = c < res.count ? rowBuf[c] : NaN;
          }
          rows++;
        } else {
          coordBad++;
        }
      }
    }
    i = next;
    if (rows - lastReport > 250_000) {
      lastReport = rows;
      onProgress?.(0.18 + 0.55 * Math.min(1, i / text.length), `解析坐标… ${rows.toLocaleString()}`);
      await yieldUI();
    }
  }

  if (rows === 0) {
    if (dataRows > 0 && coordBad === dataRows) {
      throw new Error(
        `已读取 ${dataRows} 行数据，但所选 X / Y / Z 坐标列全部为非有限数值。` +
          `请检查：①坐标列选择是否正确；②分隔符识别是否为「${delimLabel}」；③首行是否被误判为表头。`
      );
    }
    if (dataRows > 0) {
      throw new Error(
        `已读取 ${dataRows} 行数据，但没有任何一行能同时解析出有效的 X / Y / Z 坐标（坐标列存在非数值或缺失）。请重新选择坐标列或检查文件格式。`
      );
    }
    throw new Error('未解析到任何有效数据行（分隔符或表头可能识别有误，请检查文件格式）。');
  }

  onProgress?.(0.78, '整理属性…');
  await yieldUI();

  const positions = new Float32Array(rows * 3);
  for (let r = 0; r < rows; r++) {
    const b = r * width;
    positions[r * 3] = raw[b + xi];
    positions[r * 3 + 1] = raw[b + yi];
    positions[r * 3 + 2] = zi >= 0 ? raw[b + zi] : 0;
  }

  const scalarCols = plan.filter((p) => p.kind === 'scalar');
  const colorCols = plan.filter((p) => p.kind === 'r' || p.kind === 'g' || p.kind === 'b');

  const scalars = new Map<string, Float32Array>();
  const scalarOrder: string[] = [];
  const seenNames = new Map<string, number>();

  for (const col of scalarCols) {
    let name = col.name || `field_${col.index + 1}`;
    if (seenNames.has(name)) {
      const k = seenNames.get(name)! + 1;
      seenNames.set(name, k);
      name = `${name}_${k}`;
    } else {
      seenNames.set(name, 0);
    }
    const arr = new Float32Array(rows);
    for (let r = 0; r < rows; r++) arr[r] = raw[r * width + col.index];
    scalars.set(name, arr);
    scalarOrder.push(name);
  }

  let colors: Uint8Array | null = null;
  const ci: Record<'r' | 'g' | 'b', number> = { r: -1, g: -1, b: -1 };
  for (const c of colorCols) ci[c.kind as 'r' | 'g' | 'b'] = c.index;
  if (ci.r >= 0 && ci.g >= 0 && ci.b >= 0) {
    colors = new Uint8Array(rows * 3);
    for (let r = 0; r < rows; r++) {
      const b0 = r * width;
      colors[r * 3] = clamp255(raw[b0 + ci.r]);
      colors[r * 3 + 1] = clamp255(raw[b0 + ci.g]);
      colors[r * 3 + 2] = clamp255(raw[b0 + ci.b]);
    }
  } else if (!hasHeader && scalarCols.length === 3) {
    // Headerless with exactly 3 extra columns → guess RGB when in 0..255.
    const cols = scalarCols.map((s) => s.index);
    let ok = true;
    const lim = Math.min(rows, 2000);
    for (let r = 0; r < lim && ok; r++) {
      const bb = r * width;
      for (const c of cols) {
        const v = raw[bb + c];
        if (!(v >= 0 && v <= 255)) { ok = false; break; }
      }
    }
    if (ok) {
      colors = new Uint8Array(rows * 3);
      for (let r = 0; r < rows; r++) {
        const bb = r * width;
        colors[r * 3] = clamp255(raw[bb + cols[0]]);
        colors[r * 3 + 1] = clamp255(raw[bb + cols[1]]);
        colors[r * 3 + 2] = clamp255(raw[bb + cols[2]]);
      }
      for (const s of scalarCols) {
        scalars.delete(s.name);
        const k = scalarOrder.indexOf(s.name);
        if (k >= 0) scalarOrder.splice(k, 1);
      }
      warnings.push('末 3 列数值均在 0–255 范围内，已按 RGB 颜色解释。');
    }
  }

  if (declaredCount > 0 && declaredCount !== rows) {
    warnings.push(`PTS 头部声明 ${declaredCount.toLocaleString()} 点，实际读到 ${rows.toLocaleString()} 点。`);
  }

  const data: PointCloudData = finishCloud(
    {
      count: rows,
      positions,
      colors,
      scalars,
      scalarOrder,
      warnings,
      meta: {
        列数: String(ncols),
        表头: hasHeader ? '有' : '无',
        分隔符: delimLabel,
        坐标列: selection
          ? `X#${coord.x + 1} Y#${coord.y + 1}` + (selection.mode === '3d' ? ` Z#${coord.z + 1}` : ' (2D)')
          : '自动',
      },
    },
    file.name,
    ext.toUpperCase()
  );

  onProgress?.(1, '完成');
  return { data, warnings };
}

function clamp255(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
