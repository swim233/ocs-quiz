import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物输出到 worker 的 assets 目录 (dist/), 由 wrangler 一并部署
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});