import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Db, WorkspaceName, openDb } from '../db';
import { recoverOrphans } from '../services/ledger';

/**
 * One private database file per student (and one for their sample data), under DATA_DIR/users/<id>/. A request is only ever handed the handle for the
 * student its session proves, so a query can never reach another student's rows: there are no other students' rows in that file.
 */
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface Entry { db: Db; leases: number; lastUsed: number }

export class Tenants {
  private open = new Map<string, Entry>();
  constructor(private dir: string, private o: { maxOpen?: number; now?: () => number } = {}) { mkdirSync(join(dir, 'users'), { recursive: true }); }
  private now() { return (this.o.now ?? Date.now)(); }

  /** Directory of one student's files. The id must look like an id: never a path. */
  userDir(userId: string): string {
    if (!ID_RE.test(userId)) throw new Error('invalid user id');
    const p = resolve(this.dir, 'users', userId);
    if (!p.startsWith(resolve(this.dir, 'users') + sep)) throw new Error('invalid user id');
    return p;
  }
  private key(userId: string, ws: WorkspaceName) { return `${userId}:${ws}`; }
  private file(userId: string, ws: WorkspaceName) { return join(this.userDir(userId), ws === 'demo' ? 'demo.db' : 'study.db'); }

  /** Hand out a handle and keep it open until released (an in-flight request may await a slow AI call and still use it afterwards). */
  lease(userId: string, ws: WorkspaceName): { db: Db; release: () => void } {
    const k = this.key(userId, ws);
    let e = this.open.get(k);
    if (!e) {
      const db = openDb(this.file(userId, ws));
      recoverOrphans(db);
      e = { db, leases: 0, lastUsed: this.now() };
      this.open.set(k, e);
      this.evict();
    }
    e.leases++; e.lastUsed = this.now();
    let released = false;
    return { db: e.db, release: () => { if (released) return; released = true; e!.leases--; e!.lastUsed = this.now(); } };
  }

  /** Close idle handles beyond the cap, least recently used first. A handle with an in-flight request is never closed. */
  private evict() {
    const max = this.o.maxOpen ?? 64;
    if (this.open.size <= max) return;
    const idle = [...this.open.entries()].filter(([, e]) => e.leases === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of idle) { if (this.open.size <= max) break; e.db.close(); this.open.delete(k); }
  }
  get openCount() { return this.open.size; }

  hasData(userId: string) { return existsSync(this.userDir(userId)); }

  /** Close this student's handles and delete their directory (databases, WAL files, stored uploads). Refuses while a request is in flight. */
  remove(userId: string): boolean {
    for (const ws of ['real', 'demo'] as const) { const e = this.open.get(this.key(userId, ws)); if (e && e.leases > 0) return false; }
    for (const ws of ['real', 'demo'] as const) { const k = this.key(userId, ws); const e = this.open.get(k); if (e) { try { e.db.close(); } catch { /* already closed */ } this.open.delete(k); } }
    rmSync(this.userDir(userId), { recursive: true, force: true });
    return true;
  }

  /** Delete only the sample database of one student (reset). */
  dropDemo(userId: string) {
    const k = this.key(userId, 'demo'); const e = this.open.get(k);
    if (e) { e.db.close(); this.open.delete(k); }
    for (const sfx of ['', '-wal', '-shm']) rmSync(this.file(userId, 'demo') + sfx, { force: true });
  }

  listUserIds(): string[] {
    const root = join(this.dir, 'users');
    return existsSync(root) ? readdirSync(root).filter((n) => ID_RE.test(n) && statSync(join(root, n)).isDirectory()) : [];
  }

  /** Total bytes of one student's data (for the storage quota). */
  usageBytes(userId: string): number {
    const dir = this.userDir(userId);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).reduce((a, f) => a + statSync(join(dir, f)).size, 0);
  }

  closeAll() { for (const e of this.open.values()) { try { e.db.close(); } catch { /* ignore */ } } this.open.clear(); }
}
