import { defineConfig } from 'vite';

// In a plain browser (development and the CI screenshots) the basemap host
// sends no CORS headers, so it is reached through this same-origin proxy.
// The desktop app reads it from Rust and does not use these.
const proxy = {
  '/protomaps-meta': { target: 'https://build-metadata.protomaps.dev', changeOrigin: true, rewrite: (p) => p.replace(/^\/protomaps-meta/, '') },
  '/protomaps': { target: 'https://build.protomaps.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/protomaps/, '') },
};

export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true, proxy },
  preview: { proxy },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
