import { spawn, spawnSync } from 'node:child_process';
if (!process.env.npm_execpath) throw new Error('Start using npm run personal.');
const built = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build:hosted'], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const child = spawn(process.execPath, ['dist-server/main.mjs'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', APP_MODE: 'local', HOST: '127.0.0.1', AI_PROVIDER: 'chatgpt' } });
child.on('error', () => { console.error('Could not start the personal Study Helper.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
