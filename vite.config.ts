import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

const envDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '')
  const proxyTarget = env.VITE_API_TARGET

  return {
    base: mode === 'desktop' ? './' : '/',
    envDir,
    plugins: [vue()],
    server: {
      host: env.VITE_STUDIO_HOST || undefined,
      port: env.VITE_STUDIO_PORT ? Number(env.VITE_STUDIO_PORT) : undefined,
      proxy: proxyTarget
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
            },
          }
        : undefined,
    },
  }
})
