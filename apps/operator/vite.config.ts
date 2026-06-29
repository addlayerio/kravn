import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Builds the SPA directly into the server's static dir so the single container serves it.
// In dev, proxy API/MCP calls to the running server on :8080.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: '../gateway/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Use 127.0.0.1 (not "localhost"): on dual-stack hosts localhost can resolve to ::1 (IPv6)
    // first and hit a different process bound to IPv6 :8080. The gateway binds IPv4 0.0.0.0.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/mcp': 'http://127.0.0.1:8080',
      '/metrics': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
      '/readyz': 'http://127.0.0.1:8080',
    },
  },
});
