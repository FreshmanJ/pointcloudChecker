import { defineConfig } from 'vite';

export default defineConfig({
  base: '/pointcloudChecker/',
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 3000,
  },
});
