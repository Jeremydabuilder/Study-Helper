import { createApp } from './app';
import { configFromEnv, loadEnvFile } from './config';
import { createRuntime } from './context';

loadEnvFile();
const cfg = configFromEnv();
const port = Number(process.env.PORT) || 8787;
const hostedMode = process.env.APP_MODE === 'hosted';
const loopback = (h: string) => ['127.0.0.1', '::1', 'localhost'].includes(h);

async function main() {
  if (hostedMode) {
    const { hostedConfigFromEnv } = await import('./hosted/config');
    const { createHostedApp } = await import('./hosted/hosted');
    const { makeLogger } = await import('./hosted/ops');
    const { cfg: hcfg, problems } = hostedConfigFromEnv();
    if (problems.length) { console.error(`Cannot start in hosted mode:\n - ${problems.join('\n - ')}`); process.exit(1); }
    const host = process.env.HOST || '0.0.0.0';
    const logger = makeLogger();
    const h = await createHostedApp({ cfg, hcfg, dataDir: cfg.dataDir, logger, llm: (await import('../ai/factory')).buildProvider(cfg) });
    const server = h.app.listen(port, host, () => logger.info('listening', { detail: `${hcfg.environment} on ${host}:${port}` }));
    const stop = async () => { logger.info('shutting_down'); server.close(); await h.close(); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    return;
  }
  // Local single-user mode: there is NO login. It must never be reachable from a network.
  const host = process.env.HOST || '127.0.0.1';
  if (!loopback(host)) { console.error(`Refusing to start: local mode has no login and must listen on 127.0.0.1 (HOST=${host}). To host this for other people, run with APP_MODE=hosted (see docs/DEPLOYMENT.md).`); process.exit(1); }
  const rt = createRuntime(cfg);
  createApp(rt).listen(port, host, () => {
    console.log(`Study Helper running at http://localhost:${port}`);
    console.log(`  AI:       ${cfg.anthropicKey ? `Anthropic (${cfg.model})` : 'Offline mode (no ANTHROPIC_API_KEY set)'}`);
    console.log(`  Calendar: ${cfg.google ? 'Google Calendar (read-only) configured' : 'Google not configured (manual entry + demo calendar only)'}`);
    console.log(`  Data:     ${cfg.dataDir}`);
  });
}
main().catch((e) => { console.error('Startup failed:', e instanceof Error ? e.message : 'error'); process.exit(1); });
