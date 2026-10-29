// After the production build, remove packages that exist only because dev tooling (vite, vitest) or an optional peer pulled them in.
// They are never executed in production (no dev server, no test runner), and removing them also removes their known advisories from the deployed image.
import { rmSync, existsSync } from 'node:fs';
const gone = ['vitest', 'vite', 'vite-node', 'tinypool', 'esbuild', '@esbuild', '@vitest', '@playwright', 'playwright', 'playwright-core', 'rollup', '@rollup', 'tsx', 'typescript'];
let n = 0;
for (const p of gone) { const d = `node_modules/${p}`; if (existsSync(d)) { rmSync(d, { recursive: true, force: true }); n++; } }
console.log(`pruned ${n} dev-only package folders; run the server with: node dist-server/main.mjs`);
