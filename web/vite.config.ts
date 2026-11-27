import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const srcDir = decodeURIComponent(new URL('./src', import.meta.url).pathname)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const norm = id.replace(/\\/g, '/')
          if (norm.includes('node_modules/echarts/') || norm.includes('node_modules/zrender/')) {
            return 'vendor-echarts'
          }
          if (norm.includes('node_modules/@novnc/') || norm.includes('node_modules/@xterm/')) {
            return 'vendor-console'
          }
          if (norm.includes('node_modules/@tanstack/') || norm.includes('node_modules/zustand/')) {
            return 'vendor-query'
          }
          if (
            norm.includes('node_modules/react/') ||
            norm.includes('node_modules/react-dom/') ||
            norm.includes('node_modules/react-router/') ||
            norm.includes('node_modules/react-router-dom/') ||
            norm.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
