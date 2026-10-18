import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    exclude: ['electron/**', 'node_modules/**', 'dist/**', 'release/**'],
  },
})
