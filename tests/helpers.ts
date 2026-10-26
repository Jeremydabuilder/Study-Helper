import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { createRuntime, Runtime } from '../src/server/context';
import { AppConfig } from '../src/server/services/common';
import { AIProvider } from '../src/ai/provider';
import { CalendarGateway } from '../src/server/services/calendarGoogle';

export const baseCfg = (over: Partial<AppConfig> = {}): AppConfig => ({
  anthropicKey: null, model: 'test-model', aiTimeoutMs: 1000, aiDailyLimit: 100, google: null, appSecret: 'x'.repeat(32), dataDir: ':memory:', production: false, ...over,
});

export interface TestServer {
  port: number; rt: Runtime; clock: { now: number }; dir: string;
  call: (method: string, path: string, body?: unknown, ws?: 'real' | 'demo') => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startServer(o: { llm?: AIProvider | null; gateway?: CalendarGateway; dir?: string; cfg?: Partial<AppConfig>; start?: number } = {}): Promise<TestServer> {
  const clock = { now: o.start ?? Date.UTC(2026, 9, 26, 20, 0, 0) }; // Mon 26 Oct 2026 16:00 New York
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'sh-'));
  const rt = createRuntime(baseCfg({ dataDir: dir, ...o.cfg }), { now: () => clock.now, dir, llm: o.llm, gateway: o.gateway });
  const app = createApp(rt);
  const srv = await new Promise<import('node:http').Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = (srv.address() as AddressInfo).port;
  return {
    port, rt, clock, dir,
    async call(method, path, body, ws = 'real') {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-workspace': ws }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    close: () => new Promise((res) => srv.close(() => res())),
  };
}

export const NOTES = `--- Page 1 ---
Photosynthesis: the process plants use to turn light, water and carbon dioxide into glucose and oxygen.
Chlorophyll: the green pigment in chloroplasts that absorbs light energy for photosynthesis.
Cellular respiration: the process cells use to release energy from glucose, using oxygen and producing carbon dioxide.
Stomata: tiny openings in leaves that let carbon dioxide in and oxygen out.
`;

let n = 0;
export const token = () => `tok-${Date.now()}-${n++}-abcdef`;
