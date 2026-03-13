import { defineConfig } from 'tsdown/config'

export default defineConfig({
  entry: ['src/extension.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
  sourcemap: false,
  clean: true,
  deps: {
    alwaysBundle: [/^agentic-jupyter(?:\/.*)?$/, 'ws'],
    neverBundle: ['vscode'],
    onlyBundle: false,
  },
})
