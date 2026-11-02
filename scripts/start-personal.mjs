import { spawn, spawnSync } from 'node:child_process';
if (!process.env.npm_execpath) { console.error('Start it with: npm run personal'); process.exit(1); }
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) { console.error(`Study Helper needs Node 22.13 or newer; this is ${process.versions.node}. Install the current LTS from https://nodejs.org and open a new terminal.`); process.exit(1); }
const built = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build:hosted'], { stdio: 'inherit' });
if (built.status !== 0) { console.error('The build failed, so nothing was started. Run "npm ci" once, then try again.'); process.exit(built.status ?? 1); }
// This mode is for one person on one computer: loopback only, the ChatGPT sign-in, no shared hosting.
const child = spawn(process.execPath, ['dist-server/main.mjs'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', APP_MODE: 'local', HOST: '127.0.0.1', AI_PROVIDER: 'chatgpt' } });
child.on('error', () => { console.error('Could not start the personal Study Helper.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
