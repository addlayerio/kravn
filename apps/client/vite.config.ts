import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The client is a separate deployable. In dev it runs on :5174 and proxies API calls to the gateway.
export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    // Use 127.0.0.1 (not "localhost"): on dual-stack hosts localhost can resolve to ::1 (IPv6)
    // first and hit a different process bound to IPv6 :8080. The gateway binds IPv4 0.0.0.0.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
    },
  },
});
