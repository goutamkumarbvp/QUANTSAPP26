import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // By module path, not by entry: naming 'echarts/charts' as an entry would pull every chart type into the
        // chunk and undo tree-shaking (Chart.tsx imports only the charts and components it draws).
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](echarts|zrender|tslib)[\\/]/.test(id)) return 'echarts';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@tanstack|zustand|use-sync-external-store)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
