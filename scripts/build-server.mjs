// Bundles the server into dist-server/ so production runs plain `node` (no TypeScript runtime). Dependencies stay external and are installed with `npm ci --omit=dev`.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist-server', { recursive: true, force: true });
mkdirSync('dist-server', { recursive: true });
const shared = { bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: false, logLevel: 'info' };
await build({ ...shared, entryPoints: { main: 'src/server/main.ts' }, outdir: 'dist-server', outExtension: { '.js': '.mjs' } });
await build({ ...shared, entryPoints: { operator: 'src/server/ops/cli.ts' }, outdir: 'dist-server', outExtension: { '.js': '.mjs' } });
// files the server reads at run time, next to the bundle
cpSync('src/server/migrations', 'dist-server/migrations', { recursive: true });
cpSync('src/server/control-migrations', 'dist-server/control-migrations', { recursive: true });
cpSync('src/server/pdfWorker.mjs', 'dist-server/pdfWorker.mjs');
console.log('server built: dist-server/main.mjs, dist-server/operator.mjs');
