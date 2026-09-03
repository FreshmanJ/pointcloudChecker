/** Export helpers: images, tables, point-cloud files and project presets. */

import type { CloudView } from '../core/cloud';
import { profileToCSV, type ProfileResult } from '../core/profile';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

export function downloadDataURL(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Full point dump of the current view. */
export function viewToCSV(view: CloudView, fields: string[]): string {
  const head = ['x', 'y', 'z', ...fields];
  const cols = new Map<string, Float32Array>();
  for (const f of fields) {
    const arr = view.values(f);
    if (arr) cols.set(f, arr);
  }
  const hasColor = !!view.colors;
  if (hasColor) head.push('r', 'g', 'b');

  const pos = view.positions;
  const colors = view.colors;
  const lines: string[] = [head.join(',')];
  const n = view.count;
  const parts: string[] = new Array(head.length);
  for (let i = 0; i < n; i++) {
    parts[0] = String(pos[i * 3]);
    parts[1] = String(pos[i * 3 + 1]);
    parts[2] = String(pos[i * 3 + 2]);
    let k = 3;
    for (const f of fields) {
      const arr = cols.get(f);
      parts[k++] = arr ? String(arr[i]) : '';
    }
    if (colors) {
      parts[k++] = String(colors[i * 3]);
      parts[k++] = String(colors[i * 3 + 1]);
      parts[k++] = String(colors[i * 3 + 2]);
    }
    lines.push(parts.join(','));
  }
  return lines.join('\n');
}

export function viewToPLY(view: CloudView, fields: string[]): string {
  const cols: { name: string; arr: Float32Array }[] = [];
  for (const f of fields) {
    const arr = view.values(f);
    if (arr) cols.push({ name: f, arr });
  }
  const hasColor = !!view.colors;
  const head = [
    'ply',
    'format ascii 1.0',
    `comment exported by PointCloud Inspector`,
    `element vertex ${view.count}`,
    'property float x',
    'property float y',
    'property float z',
    ...(hasColor ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    ...cols.map((c) => `property float ${c.name.replace(/[^a-zA-Z0-9_]/g, '_')}`),
    'end_header',
  ];
  const pos = view.positions;
  const colors = view.colors;
  const lines: string[] = [...head];
  const n = view.count;
  const buf: string[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    buf.push(String(pos[i * 3]), String(pos[i * 3 + 1]), String(pos[i * 3 + 2]));
    if (colors) buf.push(String(colors[i * 3]), String(colors[i * 3 + 1]), String(colors[i * 3 + 2]));
    for (const c of cols) buf.push(String(c.arr[i]));
    lines.push(buf.join(' '));
  }
  return lines.join('\n');
}

export function viewToPCD(view: CloudView, fields: string[]): string {
  const cols: { name: string; arr: Float32Array }[] = [];
  for (const f of fields) {
    const arr = view.values(f);
    if (arr) cols.push({ name: f.replace(/[^a-zA-Z0-9_]/g, '_'), arr });
  }
  const names = ['x', 'y', 'z', ...cols.map((c) => c.name)];
  const sizes = names.map(() => '4');
  const types = names.map(() => 'F');
  const counts = names.map(() => '1');
  const head = [
    '# .PCD v0.7 - Point Cloud Data file format',
    'VERSION 0.7',
    `FIELDS ${names.join(' ')}`,
    `SIZE ${sizes.join(' ')}`,
    `TYPE ${types.join(' ')}`,
    `COUNT ${counts.join(' ')}`,
    `WIDTH ${view.count}`,
    'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    `POINTS ${view.count}`,
    'DATA ascii',
  ];
  const pos = view.positions;
  const lines: string[] = [...head];
  const n = view.count;
  const buf: string[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    buf.push(String(pos[i * 3]), String(pos[i * 3 + 1]), String(pos[i * 3 + 2]));
    for (const c of cols) buf.push(String(c.arr[i]));
    lines.push(buf.join(' '));
  }
  return lines.join('\n');
}

export function profileCSV(res: ProfileResult, unit: string): string {
  return profileToCSV(res, unit);
}

/** Serialise the current view settings so a session can be restored. */
export function serializePreset(payload: unknown): string {
  return JSON.stringify({ app: 'pointcloud-inspector', version: 1, payload }, null, 2);
}
