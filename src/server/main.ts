import { createApp } from './app';
import { configFromEnv, loadEnvFile } from './config';
import { createRuntime } from './context';

loadEnvFile();
const cfg = configFromEnv();
const rt = createRuntime(cfg);
const app = createApp(rt);
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1'; // local-first: not exposed to the network unless you opt in
app.listen(port, host, () => {
  console.log(`Study Helper running at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
  console.log(`  AI:       ${cfg.anthropicKey ? `Anthropic (${cfg.model})` : 'Offline mode (no ANTHROPIC_API_KEY set)'}`);
  console.log(`  Calendar: ${cfg.google ? 'Google Calendar (read-only) configured' : 'Google not configured (manual entry + demo calendar only)'}`);
  console.log(`  Data:     ${cfg.dataDir}`);
});
