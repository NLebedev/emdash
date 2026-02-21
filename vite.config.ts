import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const devPort = Number(process.env.EMDASH_DEV_PORT || 3000);
const resolvedDevPort =
  Number.isInteger(devPort) && devPort > 0 && devPort <= 65535 ? devPort : 3000;

export default defineConfig(({ command }) => ({
  // Use relative asset paths in production so file:// loads work from DMG/app bundle
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  root: './src/renderer',
  test: {
    dir: '.',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src/renderer'),
      '@shared': resolve(__dirname, './src/shared'),
      '#types': resolve(__dirname, './src/types'),
    },
  },
  server: {
    port: resolvedDevPort,
  },
}));
