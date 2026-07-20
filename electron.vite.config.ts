import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // utilityProcess entry: research static-lane HTML extraction runs
          // off the main thread (Phase 5).
          'static-extract-worker': resolve('src/main/workers/static-extract-worker.ts'),
          // Standalone MCP stdio facade over the browser tools; spawned by an
          // MCP client (Claude CLI) with plain node, proxies to the unix
          // control socket (Claude-prep step 6).
          'mcp-browser-shim': resolve('src/main/workers/mcp-browser-shim.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'omnibox-popup': resolve('src/preload/omnibox-popup.ts'),
          'browser-page': resolve('src/preload/browser-page.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          landing: resolve('src/renderer/landing.html'),
          'omnibox-popup': resolve('src/renderer/omnibox-popup.html'),
        },
      },
    },
  },
});
