import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import thirdPartyLicenses from './build/third-party-licenses.mjs';

const apiPort = Number(process.env.SCENEFORGE_API_PORT ?? process.env.SCENEFORGE_PORT ?? 4318);
const webPort = Number(process.env.SCENEFORGE_WEB_PORT ?? 4317);
const dataDir = path.resolve(process.env.SCENEFORGE_DATA_DIR ?? 'data');
const tokenFile = path.resolve(process.env.SCENEFORGE_TOKEN_FILE ?? path.join(dataDir, 'api-token'));
const devTokenCookie = {
  name: 'sceneforge-dev-token-cookie',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
        try {
          const token = readFileSync(tokenFile, 'utf8').trim();
          if (token.length >= 32) res.setHeader('Set-Cookie', `sceneforge_api_token=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=86400`);
        } catch { /* API server has not created a token yet. */ }
      }
      next();
    });
  },
};

export default defineConfig(({ mode }) => mode === 'demo'
  // Static, server-less build of the whole UI (in-browser mock API) for previewing without the desktop app.
  ? {
      plugins: [react()],
      base: './',
      publicDir: false,
      build: { outDir: 'dist-demo', emptyOutDir: true, rollupOptions: { input: 'demo.html' } },
    }
  : {
      plugins: [react(), devTokenCookie, thirdPartyLicenses(process.cwd())],
      server: {
        host: '127.0.0.1',
        port: webPort,
        strictPort: true,
        proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
      },
      build: { outDir: 'dist' },
    });
