import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts'
    },
    dts: true
  }
})
