import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const dir = import.meta.dirname;

export default defineConfig({
  root: resolve(dir, 'src'),
  publicDir: resolve(dir, 'public'),
  envDir: dir, // .env lives at the project root, not in src/
  build: {
    outDir: resolve(dir, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { sidepanel: resolve(dir, 'src/sidepanel.html'), sw: resolve(dir, 'src/sw.ts') },
      output: { entryFileNames: '[name].js', chunkFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
  },
});
