/**
 * LAZ (laszip) decompression through the laz-perf WASM build.
 * The module is imported lazily so the ~220 kB wasm is only fetched when a
 * .laz file is actually opened.
 */

import type { ProgressFn } from './common';
import { yieldUI } from './common';

import wasmUrl from 'laz-perf/lib/laz-perf.wasm?url';

interface LazPerfModule {
  _malloc(n: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  LASZip: new () => {
    open(ptr: number, length: number): void;
    getPoint(dest: number): void;
    getCount(): number;
    getPointLength(): number;
    getPointFormat(): number;
    delete(): void;
  };
  ChunkDecoder: new () => {
    open(format: number, length: number, ptr: number): void;
    getPoint(dest: number): void;
    delete(): void;
  };
}

let cached: Promise<LazPerfModule> | null = null;

function loadModule(): Promise<LazPerfModule> {
  if (!cached) {
    cached = import('laz-perf').then((m) => {
      const factory = (m as unknown as { default?: (opts: unknown) => Promise<LazPerfModule> }).default
        ?? (m as unknown as { createLazPerf: (opts: unknown) => Promise<LazPerfModule> }).createLazPerf
        ?? (m as unknown as { create: (opts: unknown) => Promise<LazPerfModule> }).create;
      if (typeof factory !== 'function') throw new Error('laz-perf 模块导出异常');
      return factory({ locateFile: () => wasmUrl, wasmBinaryFile: wasmUrl });
    });
  }
  return cached;
}

/** Decode the whole LAZ file into raw, uncompressed point records. */
export async function decompressLaz(buf: ArrayBuffer, onProgress?: ProgressFn): Promise<ArrayBuffer> {
  const mod = await loadModule();
  const bytes = new Uint8Array(buf);

  const inPtr = mod._malloc(bytes.byteLength);
  if (!inPtr) throw new Error('LAZ 解码器内存分配失败');
  mod.HEAPU8.set(bytes, inPtr);

  const laszip = new mod.LASZip();
  try {
    laszip.open(inPtr, bytes.byteLength);
    const count = laszip.getCount();
    const pointLength = laszip.getPointLength();
    if (!(count > 0) || !(pointLength > 0)) {
      throw new Error('LAZ 头部信息无效（点数为 0 或点记录长度为 0）');
    }

    const outPtr = mod._malloc(pointLength);
    if (!outPtr) throw new Error('LAZ 解码器内存分配失败');
    const total = count * pointLength;
    const out = new Uint8Array(total);

    let last = 0;
    for (let i = 0; i < count; i++) {
      laszip.getPoint(outPtr);
      // Re-read HEAPU8 every iteration: the emscripten heap may have grown.
      out.set(mod.HEAPU8.subarray(outPtr, outPtr + pointLength), i * pointLength);
      if (i - last > 500_000) {
        last = i;
        onProgress?.(0.2 + 0.38 * (i / count), `解压 LAZ… ${i.toLocaleString()}`);
        await yieldUI();
      }
    }
    mod._free(outPtr);
    return out.buffer;
  } finally {
    laszip.delete();
    mod._free(inPtr);
  }
}
