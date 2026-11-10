import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // cargo 编译时 src-tauri/target 里的 exe 会被锁住，Vite 监听会崩（EBUSY）
      ignored: ['**/src-tauri/**', '**/gateway/**', '**/dist/**'],
    },
  },
});
