import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    fs: {
      strict: true,
      deny: [
        '.env', '.env.*', '*.{crt,pem}',
        '**/.git/**', '**/.tools/**', '**/.chrome-profile/**', '**/evidence/**'
      ]
    }
  },
  build: { outDir: 'dist' }
});
