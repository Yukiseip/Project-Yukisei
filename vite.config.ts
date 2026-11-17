import Vue from '@vitejs/plugin-vue'
import Unocss from 'unocss/vite'

import { DownloadLive2DSDK } from '@proj-airi/unplugin-live2d-sdk/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // NOTICE:
  // Electron loads the built page from a file path, so assets need relative URLs.
  // Root cause: the default base `/` points at the drive root under `file://`.
  // Source: Electron `loadFile` behavior.
  // Removal condition: delete if the app serves its page over HTTP.
  base: './',
  optimizeDeps: {
    exclude: [
      '@proj-airi/stage-ui-live2d',
      '@framework/live2dcubismframework',
      '@framework/math/cubismmatrix44',
      '@framework/type/csmvector',
      '@framework/math/cubismviewmatrix',
      '@framework/cubismdefaultparameterid',
      '@framework/cubismmodelsettingjson',
      '@framework/effect/cubismbreath',
      '@framework/effect/cubismeyeblink',
      '@framework/model/cubismusermodel',
      '@framework/motion/acubismmotion',
      '@framework/motion/cubismmotionqueuemanager',
      '@framework/type/csmmap',
      '@framework/utils/cubismdebug',
      '@framework/model/cubismmoc',
    ],
  },
  server: {
    port: 5180,
    strictPort: true,
    fs: { strict: false },
  },
  plugins: [
    Vue(),
    Unocss(),
    DownloadLive2DSDK(),
  ],
})
