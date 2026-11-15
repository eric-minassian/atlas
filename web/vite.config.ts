import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// `plat dev` serves everything on its local router (default :3000) and proxies
// frontend requests here; opening this dev server directly also works because
// API and platform routes are proxied back to the router.
const router = process.env.PLATFORM_DEV_ROUTER ?? 'http://localhost:3000';
// `plat dev` picks a free port for this server and waits for exactly that one.
const port = Number(process.env.PLATFORM_DEV_WEB_PORT ?? 5173);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    // CesiumJS loads its web workers, textures and third-party wasm at runtime
    // from CESIUM_BASE_URL rather than through the bundle.
    viteStaticCopy({
      targets: [
        {
          src: '../node_modules/cesium/Build/Cesium/{Workers,ThirdParty,Assets,Widgets}',
          dest: 'cesium',
          // Drop `../node_modules/cesium/Build/Cesium/`, keeping `Workers/…` and the rest.
          rename: { stripBase: 4 },
        },
      ],
    }),
  ],
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // CesiumJS is ~4 MB; it gets its own chunk, which app changes don't invalidate.
    chunkSizeWarningLimit: 5000,
    rolldownOptions: {
      output: {
        manualChunks: (id) => (/[\\/](@cesium|cesium)[\\/]/.test(id) ? 'cesium' : undefined),
      },
      // satellite.js re-exports a WebAssembly propagator from its entry and
      // declares no `sideEffects`; we only use the JS one.
      treeshake: { moduleSideEffects: (id) => (id.includes('/satellite.js/') ? false : undefined) },
    },
  },
  worker: { format: 'es' },
  server: {
    port,
    strictPort: true,
    proxy: { '/api': router, '/__platform': router },
  },
});
