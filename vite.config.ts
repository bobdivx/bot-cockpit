import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact()],
  server: {
    host: '0.0.0.0',
    port: 8742,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8741', changeOrigin: false },
      '/mcp': { target: 'http://127.0.0.1:8741', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
