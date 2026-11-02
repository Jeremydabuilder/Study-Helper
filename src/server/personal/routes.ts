import type { Express } from 'express';
import { randomBytes } from 'node:crypto';
import { ChatGPTConnection } from './chatgpt';
import { buildProvider } from '../../ai/factory';
import type { Runtime } from '../context';
const COOKIE = 'sh_chatgpt_oauth';
export function mountChatGPT(app: Express, rt: Runtime, connection: ChatGPTConnection) {
  const reload = () => { rt.llm = buildProvider(rt.cfg, connection); };
  const route = (fn: (req: any, res: any) => unknown) => async (req: any, res: any, next: any) => { try { await fn(req, res); } catch (e) { next(e); } };
  app.get('/api/chatgpt/status', (_req, res) => res.json(connection.status()));
  app.post('/api/chatgpt/connect', route((req, res) => {
    const browser = randomBytes(32).toString('base64url');
    const url = connection.begin(`http://${req.headers.host}`, browser);
    res.cookie(COOKIE, browser, { httpOnly: true, sameSite: 'lax', maxAge: 600000, path: '/auth/chatgpt/callback' });
    res.json({ url });
  }));
  app.get('/auth/chatgpt/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const browser = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? null;
    res.clearCookie(COOKIE, { path: '/auth/chatgpt/callback' });
    try {
      await connection.callback(new URL(req.originalUrl, 'http://127.0.0.1').searchParams, browser);
      reload(); res.redirect('/#/settings?tab=setup&chatgpt=connected');
    } catch { res.redirect('/#/settings?tab=setup&chatgpt=failed'); }
  });
  app.get('/api/chatgpt/models', route(async (_req, res) => res.json(await connection.models())));
  app.post('/api/chatgpt/model', route(async (req, res) => {
    if (typeof req.body?.model !== 'string' || req.body.model.length > 200) return res.status(400).json({ error: { code: 'bad_model', message: 'Choose a ChatGPT model.' } });
    await connection.selectModel(req.body.model); reload(); res.json(connection.status());
  }));
  app.post('/api/chatgpt/welcome', (_req, res) => { connection.welcome(); res.json(connection.status()); });
  app.post('/api/chatgpt/disconnect', (_req, res) => { connection.disconnect(); reload(); res.json(connection.status()); });
}
