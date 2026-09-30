import { defineConfig } from '@playwright/test';

// The generated API server runs on an uncommon port during tests so a stray
// process on the default port cannot be mistaken for it. Override with
// GRHM_API_PORT if this port is taken on your machine.
const API_PORT = process.env.GRHM_API_PORT ?? '34787';

export default defineConfig({
  testDir: 'src/gen/tests',
  testMatch: '**/*.spec.ts',
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: (process.features as { typescript?: unknown }).typescript
        ? 'node src/gen/server.ts'
        : 'node --experimental-strip-types src/gen/server.ts',
      port: Number(API_PORT),
      reuseExistingServer: false,
      env: { ...process.env, GRHM_DB: ':memory:', GRHM_TEST_HOOKS: '1', PORT: API_PORT },
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: true,
      env: { ...process.env, GRHM_API_PORT: API_PORT },
    },
  ],
});
