import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    assetsInclude: ['**/*.svg', '**/*.csv'],

    server: {
      proxy: apiTarget
        ? {
            '/api': { target: apiTarget, changeOrigin: true, secure: true },
            '/uploads': { target: apiTarget, changeOrigin: true, secure: true },
          }
        : {},
    },

    preview: {
      host: '0.0.0.0',
      port: 8080,
      allowedHosts: [
        'monkfish-app-dtv2k.ondigitalocean.app',
        'whale-app-j7j64.ondigitalocean.app',
      ],
    },
  }
})
