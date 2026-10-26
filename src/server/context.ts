import { AIProvider } from '../ai/provider';
import { buildProvider } from '../ai/factory';
import { OfflineProvider } from '../ai/offline';
import { WorkspaceName, Workspaces } from './db';
import { AppConfig, Ctx, metered } from './services/common';
import { CalendarGateway, GoogleGateway, MemoryGateway, UnconfiguredGateway } from './services/calendarGoogle';
import { seedDemo, demoCalendarEvents } from './demoSeed';

export interface Runtime {
  cfg: AppConfig; workspaces: Workspaces; now: () => number;
  llm: AIProvider | null; offline: OfflineProvider; googleGw: CalendarGateway; demoGw: MemoryGateway;
  ctx(name: WorkspaceName): Ctx;
  /** Seeds the sample workspace once (async: it drives the real practice loop on a simulated clock). */
  ensureDemo(): Promise<void>;
  resetDemo(): Promise<void>;
}

export function createRuntime(cfg: AppConfig, o: { now?: () => number; dir?: string | ':memory:'; llm?: AIProvider | null; gateway?: CalendarGateway } = {}): Runtime {
  const now = o.now ?? Date.now;
  const offline = new OfflineProvider();
  const llm = o.llm !== undefined ? o.llm : buildProvider(cfg);
  const demoGw = new MemoryGateway();
  const googleGw: CalendarGateway = o.gateway ?? (cfg.google ? new GoogleGateway(cfg.google) : new UnconfiguredGateway());
  let demoReady: Promise<void> | null = null;
  const rt: Runtime = {
    cfg, now, llm, offline, googleGw, demoGw,
    workspaces: new Workspaces(o.dir ?? cfg.dataDir),
    ensureDemo() {
      demoReady ??= (async () => {
        const db = rt.workspaces.get('demo');
        if (!db.get("SELECT 1 FROM settings WHERE key = 'demo_seeded'")) await seedDemo(db, { cfg, now, offline, demoGw });
        else demoCalendarEvents(db, demoGw, now());
      })();
      return demoReady;
    },
    async resetDemo() { demoReady = null; demoGw.calendars = []; demoGw.events.clear(); rt.workspaces.dropDemo(); await rt.ensureDemo(); },
    ctx(name) {
      const db = rt.workspaces.get(name);
      if (name === 'demo') {
        return { db, workspace: name, now, ai: offline, offline, cfg, calendar: demoGw };
      }
      const base: Ctx = { db, workspace: name, now, ai: offline, offline, cfg, calendar: googleGw };
      return { ...base, ai: llm ? metered(base, llm) : offline };
    },
  };
  return rt;
}
