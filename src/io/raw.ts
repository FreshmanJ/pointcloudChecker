/**
 * Raw binary float32 triple stream (x, y, z, …) with no header.
 */

import { finishCloud, type ProgressFn } from './common';
import type { ParseOutcome } from './common';

export async function parseRawBinary(file: File, onProgress?: ProgressFn): Promise<ParseOutcome> {
  const buf = await file.arrayBuffer();
  const warnings: string[] = [];
  const strideCandidates = [3, 4, 6, 7];
  let stride = 3;
  for (const s of strideCandidates) {
    if (buf.byteLength % (s * 4) === 0) { stride = s; break; }
  }
  const count = Math.floor(buf.byteLength / (stride * 4));
  if (count <= 0) throw new Error('文件不是有效的 float32 三元组流');

  const f32 = new Float32Array(buf);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = f32[i * stride];
    positions[i * 3 + 1] = f32[i * stride + 1];
    positions[i * 3 + 2] = f32[i * stride + 2];
  }

  const scalars = new Map<string, Float32Array>();
  const scalarOrder: string[] = [];
  if (stride >= 4) {
    warnings.push(`按每行 ${stride} 个 float32 解释：x y z${stride > 3 ? ' + 附加字段' : ''}。`);
    for (let c = 3; c < stride; c++) {
      const name = `field_${c + 1}`;
      const arr = new Float32Array(count);
      for (let i = 0; i < count; i++) arr[i] = f32[i * stride + c];
      scalars.set(name, arr);
      scalarOrder.push(name);
    }
  }

  const data = finishCloud(
    { count, positions, colors: null, scalars, scalarOrder, warnings, meta: { 步长: `${stride}×float32` } },
    file.name,
    'BIN'
  );
  onProgress?.(1, '完成');
  return { data, warnings };
}
