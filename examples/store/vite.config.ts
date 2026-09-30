import fs from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// When the app declares (db ...)/(api ...), grhm emits src/gen/server.ts and
// /api requests are proxied to it (grhm dev starts it and sets GRHM_API_PORT).
const hasApiServer = fs.existsSync('./src/gen/server.ts');
const apiPort = process.env.GRHM_API_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: hasApiServer ? { proxy: { '/api': 'http://127.0.0.1:' + apiPort } } : undefined,
});
