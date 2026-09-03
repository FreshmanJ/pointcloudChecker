/// <reference types="vite/client" />

declare module 'laz-perf' {
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
  const createLazPerf: (opts?: Record<string, unknown>) => Promise<LazPerfModule>;
  export default createLazPerf;
  export { createLazPerf };
}

declare module '*.wasm?url' {
  const src: string;
  export default src;
}
