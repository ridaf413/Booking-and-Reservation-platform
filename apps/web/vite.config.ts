import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { port: Number(process.env.WEB_PORT || 5173), strictPort: true, proxy: { '/api': process.env.API_PROXY || 'http://127.0.0.1:4000' } }, test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.tsx'] } });
