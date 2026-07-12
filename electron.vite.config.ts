import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'omnibox-popup': resolve('src/preload/omnibox-popup.ts'),
          'browser-page': resolve('src/preload/browser-page.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          landing: resolve('src/renderer/landing.html'),
          'omnibox-popup': resolve('src/renderer/omnibox-popup.html')
        }
      }
    }
  }
})
