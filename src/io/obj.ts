/**
 * Wavefront OBJ — imports vertices only (with optional trailing r g b).
 */

import type { PointCloudData } from '../core/cloud';
import { finishCloud, yieldUI, type ProgressFn } from './common';
import type { ParseOutcome } from './common';

export async function parseOBJ(file: File, onProgress?: ProgressFn): Promise<ParseOutcome> {
  onProgress?.(0.05, '读取文件…');
  const text = await file.text();
  const warnings: string[] = ['仅导入 OBJ 的顶点（v），面与法线已忽略。'];

  const posList: number[] = [];
  const colList: number[] = [];
  let hasColor = true;

  let i = 0;
  let last = 0;
  const len = text.length;
  while (i < len) {
    let e = text.indexOf('\n', i);
    if (e < 0) e = len;
    if (text.charCodeAt(i) === 118 /* v */ && text.charCodeAt(i + 1) === 32) {
      // Fast manual tokenisation of "v x y z [r g b]".
      const nums: number[] = [];
      let p = i + 2;
      while (p < e) {
        while (p < e && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p++;
        if (p >= e) break;
        let sign = 1;
        if (text.charCodeAt(p) === 45) { sign = -1; p++; }
        else if (text.charCodeAt(p) === 43) p++;
        let mant = 0;
        let frac = 0;
        let div = 1;
        let digits = 0;
        while (p < e) {
          const c = text.charCodeAt(p);
          if (c >= 48 && c <= 57) { mant = mant * 10 + (c - 48); digits++; p++; }
          else break;
        }
        if (p < e && text.charCodeAt(p) === 46) {
          p++;
          while (p < e) {
            const c = text.charCodeAt(p);
            if (c >= 48 && c <= 57) { frac = frac * 10 + (c - 48); div *= 10; digits++; p++; }
            else break;
          }
        }
        if (digits === 0) { p++; continue; }
        nums.push(sign * (mant + frac / div));
        if (nums.length >= 7) break;
      }
      if (nums.length >= 3) {
        posList.push(nums[0], nums[1], nums[2]);
        if (nums.length >= 6) colList.push(nums[3], nums[4], nums[5]);
        else hasColor = false;
      }
    }
    i = e + 1;
    if (posList.length - last > 600_000) {
      last = posList.length;
      onProgress?.(0.1 + 0.7 * (i / len), `解析顶点… ${(posList.length / 3).toLocaleString()}`);
      await yieldUI();
    }
  }

  const count = posList.length / 3;
  if (count === 0) throw new Error('OBJ 中没有顶点');

  const positions = new Float32Array(posList);
  let colors: Uint8Array | null = null;
  if (hasColor && colList.length === count * 3) {
    colors = new Uint8Array(count * 3);
    for (let k = 0; k < colList.length; k++) {
      // OBJ stores colours in 0..1
      const v = colList[k] <= 1.0001 ? colList[k] * 255 : colList[k];
      colors[k] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }

  const data: PointCloudData = finishCloud(
    { count, positions, colors, scalars: new Map(), scalarOrder: [], warnings, meta: {} },
    file.name,
    'OBJ'
  );
  onProgress?.(1, '完成');
  return { data, warnings };
}
