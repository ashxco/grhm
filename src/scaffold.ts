/** Templates written by `grhm new`. */

/** Canonically formatted (format(parse(x)) === x), so a fresh project passes `grhm fmt --check`; a test enforces it. */
export const DEFAULT_APP_GRHM = `(app my-app
  (theme (token primary "#4f46e5") (token surface "#ffffff"))

  (state count 0)

  (page "/" home
    (v :pad 32 :gap 16 :align start :max-w 640 :margin "0 auto"
      (heading "Welcome to GRHM")
      (txt "This page was compiled from app.grhm.")
      (txt "Count: " count)
      (h :gap 8
        (btn "Increment" :variant primary
          (click
            (set count (+ count 1))))
        (btn "Reset"
          (click (set count 0)))))))
`;

export const GRHM_JSON = `{
  "entry": "app.grhm",
  "outDir": "src/gen"
}
`;

export function projectPackageJson(name: string, grhmDependency: string): string {
  return JSON.stringify(
    {
      name,
      private: true,
      version: '0.0.0',
      type: 'module',
      scripts: {
        dev: 'grhm dev',
        build: 'grhm build',
        start: 'node --experimental-strip-types grhm-start.mjs',
        check: 'grhm check',
        fmt: 'grhm fmt',
      },
      dependencies: {
        react: '^19.2.8',
        'react-dom': '^19.2.8',
      },
      // Same policy as the compiler: node:sqlite needs 22.13; 22.22+/24.15+ run the generated TypeScript without flags.
      engines: { node: '>=22.13' },
      devDependencies: {
        '@types/node': '^26.1.2',
        '@types/react': '^19.2.18',
        '@types/react-dom': '^19.2.4',
        '@vitejs/plugin-react': '^6.0.5',
        grhm: grhmDependency,
        jsdom: '^30.0.1',
        typescript: '^7.0.2',
        vite: '^8.2.1',
        vitest: '^4.1.11',
      },
    },
    null,
    2,
  ) + '\n';
}

export function indexHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

export const MAIN_TSX = `import { createRoot } from 'react-dom/client';
import { App } from '@grhm/App';
import '@grhm/styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('missing #root element');
createRoot(rootElement).render(<App />);
`;

export const VITE_ENV_DTS = `/// <reference types="vite/client" />

declare module '@grhm/App' {
  import type { ComponentType } from 'react';
  export const App: ComponentType;
}

declare module '@grhm/styles.css';
`;

export const VITE_CONFIG = `import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// When the app declares (db ...)/(api ...), grhm emits <outDir>/server.ts and
// /api requests are proxied to it (grhm dev starts it and sets GRHM_API_PORT).
const grhmConfig = JSON.parse(fs.readFileSync('./grhm.json', 'utf8')) as { outDir?: string };
const generatedDir = grhmConfig.outDir ?? 'src/gen';
const apiPort = process.env.GRHM_API_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@grhm': path.resolve(generatedDir) } },
  // Keep the proxy installed even before the first backend declaration is
  // added; grhm dev can then start/stop the generated server without a Vite
  // restart when the project topology changes.
  server: { proxy: { '/api': 'http://127.0.0.1:' + apiPort, '/uploads': 'http://127.0.0.1:' + apiPort } },
});
`;

export const PROJECT_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "types": ["node", "vite/client"]
  },
  "include": ["src"],
  "exclude": ["**/gen/tests", "**/tests/*.spec.ts", "**/tests/*.unit.test.tsx"]
}
`;

export const PROJECT_GITIGNORE = `node_modules/
dist/
src/gen/
grhm.db
`;

/**
 * npm 10 (bundled with every Node 22 LTS) crashes in its peer-dependency
 * resolver ("Cannot read properties of null (reading 'edgesOut')") when the
 * registry's latest vitest major differs from the one a fresh project pins:
 * an optional-peer chain pulls both in and arborist dereferences a clobbered
 * node. npm 11+ (Node 24) is fixed upstream. legacy-peer-deps skips that
 * resolver; the scaffold's dependency set needs no automatic peers.
 */
export const PROJECT_NPMRC = `# npm 10 (Node 22) crashes resolving optional peer dependencies of the test
# toolchain; npm 11+ (Node 24) does not. Remove once the project runs on npm 11+.
legacy-peer-deps=true
`;

/**
 * Production image: compile + bundle at build time, then run the generated
 * server (serves dist/ with history-route fallback and hosts /api).
 * SQLite lives on a volume via GRHM_DB.
 */
export const DOCKERFILE = `FROM node:22-slim AS build
WORKDIR /app
# Include local file dependencies before installing the locked tree.
COPY . .
RUN npm ci
RUN npx grhm build
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# outDir is project-configurable and may live anywhere under /app. Copy the
# built project tree rather than assuming src/gen so grhm start sees the
# exact generated path recorded in grhm.json.
COPY --chown=node:node --from=build /app ./
ENV PORT=8787
ENV HOST=0.0.0.0
ENV GRHM_DB=/data/grhm.db
ENV GRHM_UPLOADS=/data/uploads
ENV GRHM_SECURE=1
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>r.json()).then(x=>process.exit(x.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "grhm-start.mjs"]
`;

/** No compiler, bundler, or other development package is required at runtime. */
export const START_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(fs.readFileSync('grhm.json', 'utf8'));
const directory = path.resolve(config.outDir ?? 'src/gen');
const hasApi = fs.existsSync(path.join(directory, 'server.ts'));
const entry = path.join(directory, hasApi ? 'server.ts' : 'static-server.ts');
const runtime = await import(pathToFileURL(entry).href);
if (hasApi) runtime.startServer(Number(process.env.PORT ?? 8787));
else runtime.startStaticServer();
`;

export const DOCKERIGNORE = `node_modules
dist
.git
.env
.env.*
*.db
*.db-*
uploads
`;
