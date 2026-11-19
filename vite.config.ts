import path from 'node:path'
import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import zip from 'vite-plugin-zip-pack'
import manifest from './manifest.config.js'
import pkg from './package.json' with { type: 'json' }

const { name, version } = pkg
const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
  build: {
    rollupOptions: {
      // Emit pages opened by the extension that are not manifest entry points.
      input: {
        callback: path.resolve(root, 'callback.html'),
        setup: path.resolve(root, 'setup.html'),
      },
    },
  },
  plugins: [
    react(),
    crx({ manifest }),
    zip({ outDir: 'release', outFileName: `crx-${name}-${version}.zip` }),
  ],
  server: {
    cors: {
      origin: [
        /chrome-extension:\/\//,
      ],
    },
  },
})
