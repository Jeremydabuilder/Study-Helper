// src/server/ops/cli.ts
import { mkdirSync as mkdirSync5 } from "node:fs";

// src/ai/schemas.ts
import { z } from "zod";
var ExtractedConcept = z.object({
  name: z.string().trim().min(2).max(90),
  summary: z.string().trim().min(5).max(500),
  /** Verbatim snippets from the source that support this concept. Verified by the app; invented ones are dropped. */
  quotes: z.array(z.string().max(400)).max(3).default([]),
  prerequisites: z.array(z.string().max(90)).max(4).default([]),
  skill_tag: z.string().max(40).nullable().optional()
});
var ConceptExtraction = z.object({ concepts: z.array(ExtractedConcept).min(1).max(20) });
var Rubric = z.object({
  key_points: z.array(z.object({ point: z.string().max(300), keywords: z.array(z.string().max(40)).max(8).default([]) })).min(1).max(8),
  sample_answer: z.string().max(800).optional()
});
var GeneratedQuestion = z.object({
  kind: z.enum(["multiple_choice", "short_answer", "explain", "math", "compare", "cause_effect", "evidence"]),
  prompt: z.string().trim().min(8).max(1200),
  choices: z.array(z.object({ text: z.string().max(300), misconception: z.string().max(200).optional() })).min(2).max(5).optional(),
  correct_choice: z.number().int().min(0).max(4).optional(),
  /** For math: canonical answer, e.g. "x = 5 or x = -2", "x > 3", "2x+6". */
  answer: z.string().max(200).optional(),
  math_type: z.enum(["set", "expr", "number"]).optional(),
  /** Machine-readable problem statement, e.g. "|2x-3| = 7". Lets the app verify the key independently. */
  relation: z.string().max(200).optional(),
  rubric: Rubric.optional(),
  hints: z.array(z.string().max(400)).min(1).max(3),
  worked_example: z.string().max(1500),
  explanation: z.string().max(1200),
  difficulty: z.number().int().min(1).max(3).default(2),
  source_quote: z.string().max(400).optional(),
  /** true when several answers could be defensible (reading, themes, motives): the app then does not treat the key as the only acceptable answer */
  interpretive: z.boolean().optional()
}).superRefine((q2, ctx) => {
  if (q2.kind === "multiple_choice" && (!q2.choices || q2.correct_choice === void 0 || q2.correct_choice >= q2.choices.length))
    ctx.addIssue({ code: "custom", message: "multiple_choice needs choices and a valid correct_choice" });
  if (q2.kind === "math" && !q2.answer) ctx.addIssue({ code: "custom", message: "math needs an answer" });
  if (q2.kind !== "multiple_choice" && q2.kind !== "math" && !q2.rubric) ctx.addIssue({ code: "custom", message: "open questions need a rubric" });
});
var QuestionBatch = z.object({ questions: z.array(GeneratedQuestion).min(1).max(8) });
var GradeResult = z.object({
  correctness: z.number().min(0).max(1),
  confidence: z.enum(["high", "medium", "low"]),
  feedback: z.string().trim().min(3).max(1500),
  points: z.array(z.object({ point: z.string().max(300), met: z.boolean(), evidence_quote: z.string().max(300).optional() })).max(10).default([]),
  misconception: z.object({ label: z.string().max(80), description: z.string().max(300) }).nullable().optional(),
  next_step: z.string().max(300).optional(),
  /** What kind of mistake, if any. The app only trusts this as one input; it never turns a single answer into a 'pattern'. */
  mistake_kind: z.enum(["missing_knowledge", "concept_confusion", "reasoning_error", "slip", "partial_explanation", "none"]).nullable().optional(),
  /** Name of the related concept the answer was really about, when mistake_kind is concept_confusion. */
  confused_with: z.string().max(90).nullable().optional()
});
var Clarification = z.object({ answer: z.string().trim().min(3).max(1500) });
var PageReading = z.object({
  pages: z.array(z.object({
    page: z.number().int().min(1).max(200),
    blocks: z.array(z.object({
      kind: z.enum(["text", "math", "table", "diagram", "handwriting", "other"]),
      text: z.string().max(8e3),
      readable: z.boolean(),
      note: z.string().max(300).optional()
    })).max(80)
  })).min(1).max(8)
});
var SupportAssessment = z.object({
  items: z.array(z.object({ index: z.number().int().min(0).max(100), verdict: z.enum(["supported", "contradicted", "insufficient"]), note: z.string().max(300).default("") })).min(1).max(24)
});
var AssistReply = z.object({ text: z.string().trim().min(3).max(2500) });
var AnnotationFeedback = z.object({
  /** restates: mostly repeats or summarises the passage. interprets: says what it means or does. develops: explains how/why with evidence and a point of view. */
  stance: z.enum(["restates", "interprets", "develops"]),
  observation: z.string().trim().min(3).max(700),
  strengths: z.string().max(500).default(""),
  next_steps: z.array(z.string().max(300)).min(1).max(3),
  questions: z.array(z.string().max(250)).max(3).default([]),
  /** how the teacher's prompt/rubric bears on this note, only when one was provided */
  prompt_link: z.string().max(400).default("")
});
var ChatReply = z.object({ reply: z.string().trim().min(1).max(8e3) });
var HomeworkReply = z.object({
  text: z.string().trim().min(3).max(4e3),
  /** Only when a missing detail would change the help (for example an unreadable part of the question). Otherwise null. */
  clarifying_question: z.string().max(300).nullable().default(null),
  basis: z.enum(["source", "general", "mixed", "none"]).default("general"),
  uncertain: z.string().max(400).nullable().default(null),
  /** worked solutions of math questions: the final answer on its own line, so the app can verify it */
  final_answer: z.string().max(200).nullable().default(null)
});
var HomeworkCheck = z.object({
  parts: z.array(z.object({
    label: z.string().max(60),
    /** words copied from the student's own work that this judgement is about */
    excerpt: z.string().max(400),
    verdict: z.enum(["correct", "needs_revision", "uncertain"]),
    why: z.string().max(500),
    next_action: z.string().max(300).default(""),
    basis: z.enum(["source", "general", "rubric", "student_work"]).default("general"),
    /** words copied from the provided source that support the judgement, when it rests on the source */
    evidence_quote: z.string().max(400).optional(),
    kind: z.enum(["quotation", "paraphrase", "interpretation", "claim", "other"]).default("other")
  })).max(12),
  not_checked: z.array(z.string().max(200)).max(8).default([]),
  overall: z.string().max(500).default(""),
  suggested_edits: z.array(z.object({ original: z.string().max(300), suggestion: z.string().max(400), reason: z.string().max(200) })).max(5).default([])
});

// src/server/config.ts
import { readFileSync, existsSync } from "node:fs";
function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === void 0) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// src/ai/pricing.ts
var flat = (inP, outP, readMult) => () => ({ inPerM: inP, outPerM: outP, cacheReadPerM: inP * readMult, cacheWritePerM: inP * 1.25 });
var RULES = [
  { match: /^claude-fable-5/, at: flat(10, 50, 0.025) },
  { match: /^claude-opus-5-5/, at: flat(4, 20, 0.05) },
  { match: /^claude-sonnet-5-5/, at: flat(2, 10, 0.05) },
  // Haiku 5.5 is priced by prompt length: prompts over 100k tokens pay the higher rates.
  { match: /^claude-haiku-5-5/, at: (p) => p > 1e5 ? { inPerM: 0.5, outPerM: 2.5, cacheReadPerM: 0.05, cacheWritePerM: 0.625 } : { inPerM: 0.1, outPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 } }
];

// src/server/services/ledger.ts
function recoverOrphans(db) {
  return Number(db.run("UPDATE ai_usage SET status='abandoned', outcome='abandoned', billing='unknown', unknown_usd=worst_usd, reserved_usd=0 WHERE status='reserved'").changes);
}

// src/server/services/common.ts
var HttpError = class extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  status;
  code;
  extra;
};

// src/server/hosted/pg.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
var here = dirname(fileURLToPath(import.meta.url));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));
function createPool(url, o = {}) {
  const pool = new pg.Pool({ connectionString: url, max: o.max ?? 10, idleTimeoutMillis: 3e4, connectionTimeoutMillis: 5e3, statement_timeout: 15e3, ssl: o.ssl ? { rejectUnauthorized: true } : void 0 });
  pool.on("error", () => {
  });
  return pool;
}
async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
    }
    throw e;
  } finally {
    c.release();
  }
}
async function migrateControl(pool) {
  const c = await pool.connect();
  const applied = [];
  try {
    await c.query("SELECT pg_advisory_lock(727001)");
    await c.query("CREATE TABLE IF NOT EXISTS control_migrations (version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT version FROM control_migrations")).rows.map((r) => r.version));
    const dir = [join(here, "..", "control-migrations"), join(here, "control-migrations")].find((d) => existsSync2(d));
    for (const f of readdirSync(dir).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) {
      const version = parseInt(f, 10);
      if (done.has(version)) continue;
      await c.query("BEGIN");
      try {
        await c.query(readFileSync2(join(dir, f), "utf8"));
        await c.query("INSERT INTO control_migrations (version, name) VALUES ($1,$2)", [version, f]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
      applied.push(f);
    }
  } finally {
    try {
      await c.query("SELECT pg_advisory_unlock(727001)");
    } catch {
    }
    c.release();
  }
  return applied;
}
async function audit(pool, event, userId, detail = {}) {
  await pool.query("INSERT INTO audit_log (event, user_id, detail) VALUES ($1,$2,$3)", [event, userId, JSON.stringify(detail)]);
}
async function getSettingPg(pool, key, fallback) {
  const r = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
async function setSettingPg(pool, key, value) {
  await pool.query("INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, JSON.stringify(value)]);
}

// src/server/hosted/limits.ts
var DEFAULT_LIMITS = {
  userDailyRequests: 60,
  userDailyUsd: 0.3,
  globalDailyUsd: 5,
  userConcurrentAi: 2,
  globalConcurrentAi: 6,
  userDailyUploads: 12,
  userDailyUploadMb: 60,
  userStorageMb: 150,
  userDailyChat: 40,
  userDailyExtractions: 15,
  globalConcurrentExtractions: 2,
  userConcurrentExtractions: 1,
  reservationTtlMs: 3 * 6e4
};
var DAY_MS = 864e5;
async function spendReport(pool, now) {
  const since = new Date(now - DAY_MS);
  const g = (await pool.query("SELECT COUNT(*)::int n, COALESCE(SUM(usd),0) usd, COALESCE(SUM(unknown_usd),0) unknown, COALESCE(SUM(reserved_usd),0) reserved FROM ai_requests WHERE created_at > $1", [since])).rows[0];
  const top = (await pool.query("SELECT COUNT(*)::int n, COALESCE(SUM(usd + unknown_usd + reserved_usd),0) held FROM ai_requests WHERE created_at > $1 AND user_id IS NOT NULL GROUP BY user_id ORDER BY held DESC LIMIT 5", [since])).rows;
  return { last24h: g, topFiveUsers: top.map((t) => ({ requests: t.n, usd: t.held })) };
}

// src/server/hosted/config.ts
var GOOGLE = { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo" };
function hostedConfigFromEnv(env = process.env) {
  const g = (k) => env[k] && env[k].trim() ? env[k].trim() : null;
  const num = (k, d) => {
    const v = g(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const environment = g("APP_ENV") ?? (env.NODE_ENV === "production" ? "production" : "test");
  const problems = [];
  const publicUrl = (g("PUBLIC_URL") ?? "").replace(/\/+$/, "");
  const authSecret = g("BETTER_AUTH_SECRET") ?? "";
  if (!["production", "staging", "test"].includes(environment)) problems.push("APP_ENV must be production, staging or test.");
  if (!g("DATABASE_URL")) problems.push("DATABASE_URL is required in hosted mode.");
  try {
    const u = new URL(publicUrl);
    const local = ["localhost", "127.0.0.1"].includes(u.hostname);
    if (environment !== "test" && u.protocol !== "https:" && !local) problems.push("PUBLIC_URL must be https in production and staging.");
  } catch {
    problems.push("PUBLIC_URL must be the full public address, e.g. https://study.example.org.");
  }
  if (authSecret.length < 32) problems.push("BETTER_AUTH_SECRET must be at least 32 random characters.");
  if (!g("APP_SECRET") || g("APP_SECRET").length < 32) problems.push("APP_SECRET must be at least 32 random characters (it protects stored Calendar tokens).");
  if (g("APP_SECRET") && g("APP_SECRET") === authSecret) problems.push("APP_SECRET and BETTER_AUTH_SECRET must be different values.");
  const clientId = g("AUTH_OIDC_CLIENT_ID") ?? g("GOOGLE_CLIENT_ID"), clientSecret = g("AUTH_OIDC_CLIENT_SECRET") ?? g("GOOGLE_CLIENT_SECRET");
  const oidc = clientId && clientSecret ? {
    providerId: g("AUTH_OIDC_PROVIDER_ID") ?? "google",
    clientId,
    clientSecret,
    authorizationUrl: g("AUTH_OIDC_AUTHORIZATION_URL") ?? GOOGLE.authorizationUrl,
    tokenUrl: g("AUTH_OIDC_TOKEN_URL") ?? GOOGLE.tokenUrl,
    userInfoUrl: g("AUTH_OIDC_USERINFO_URL") ?? GOOGLE.userInfoUrl,
    scopes: ["openid", "email"]
  } : null;
  const passwordSignIn = g("AUTH_PASSWORD") === "1";
  if (!oidc && !passwordSignIn) problems.push("Configure at least one sign-in method: Google/OIDC credentials, or AUTH_PASSWORD=1.");
  if (environment === "production" && passwordSignIn && g("AUTH_PASSWORD_ALLOW_IN_PRODUCTION") !== "1") problems.push("AUTH_PASSWORD=1 is not allowed in production unless AUTH_PASSWORD_ALLOW_IN_PRODUCTION=1 (accounts would then rely on invitations alone).");
  const dataLabel = g("DATA_LABEL") ?? environment;
  const operator = { name: g("OPERATOR_NAME") ?? "", contact: g("OPERATOR_CONTACT") ?? "" };
  if (environment === "production" && (!operator.name || !operator.contact)) problems.push("OPERATOR_NAME and OPERATOR_CONTACT are required in production: the privacy notice must say who runs the site and how to reach them.");
  const limits = {
    ...DEFAULT_LIMITS,
    userDailyRequests: num("LIMIT_USER_DAILY_AI_REQUESTS", DEFAULT_LIMITS.userDailyRequests),
    userDailyUsd: num("LIMIT_USER_DAILY_USD", DEFAULT_LIMITS.userDailyUsd),
    globalDailyUsd: num("LIMIT_GLOBAL_DAILY_USD", DEFAULT_LIMITS.globalDailyUsd),
    userConcurrentAi: num("LIMIT_USER_CONCURRENT_AI", DEFAULT_LIMITS.userConcurrentAi),
    globalConcurrentAi: num("LIMIT_GLOBAL_CONCURRENT_AI", DEFAULT_LIMITS.globalConcurrentAi),
    userDailyUploads: num("LIMIT_USER_DAILY_UPLOADS", DEFAULT_LIMITS.userDailyUploads),
    userDailyUploadMb: num("LIMIT_USER_DAILY_UPLOAD_MB", DEFAULT_LIMITS.userDailyUploadMb),
    userStorageMb: num("LIMIT_USER_STORAGE_MB", DEFAULT_LIMITS.userStorageMb),
    userDailyChat: num("LIMIT_USER_DAILY_CHAT", DEFAULT_LIMITS.userDailyChat),
    userDailyExtractions: num("LIMIT_USER_DAILY_EXTRACTIONS", DEFAULT_LIMITS.userDailyExtractions),
    globalConcurrentExtractions: num("LIMIT_GLOBAL_CONCURRENT_EXTRACTIONS", DEFAULT_LIMITS.globalConcurrentExtractions)
  };
  return { cfg: { environment, databaseUrl: g("DATABASE_URL") ?? "", publicUrl, authSecret, oidc, passwordSignIn, limits, trustProxy: g("TRUST_PROXY") !== "0", operator, sessionDays: num("SESSION_DAYS", 7), dataLabel, rate: { apiPerMin: num("RATE_API_PER_MIN", 300), authPerMin: num("RATE_AUTH_PER_MIN", 40), invitePerMin: num("RATE_INVITE_PER_MIN", 20) } }, problems };
}

// src/server/hosted/invites.ts
import { createHash, randomInt } from "node:crypto";
var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CLAIM_TTL_MS = 3 * 6e4;
var normalizeCode = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
var hashCode = (s) => createHash("sha256").update(`study-helper-invite:${normalizeCode(s)}`).digest("hex");
function newCode() {
  const c = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`;
}
async function createInvites(pool, o) {
  const count = Math.max(1, Math.min(200, Math.floor(o.count)));
  const ttl = Math.max(1, Math.min(60, Math.floor(o.ttlDays ?? 7)));
  const codes = [];
  await tx(pool, async (c) => {
    for (let i = 0; i < count; i++) {
      const code = newCode();
      codes.push(code);
      await c.query("INSERT INTO invites (code_hash, label, created_at, expires_at) VALUES ($1,$2,$3,$4)", [hashCode(code), (o.label ?? "").slice(0, 60), new Date(o.now), new Date(o.now + ttl * 864e5)]);
    }
  });
  await audit(pool, "invites_created", null, { count, ttlDays: ttl, label: (o.label ?? "").slice(0, 60) });
  return codes;
}
async function listInvites(pool, now) {
  return (await pool.query("SELECT id, label, created_at, expires_at, used_at, revoked_at, claimed_at FROM invites ORDER BY created_at DESC LIMIT 500")).rows.map((r) => ({
    id: String(r.id).slice(0, 8),
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status: r.revoked_at ? "revoked" : r.used_at ? "used" : r.expires_at.getTime() <= now ? "expired" : "open"
  }));
}
async function revokeInvites(pool, o) {
  const r = await pool.query("UPDATE invites SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL AND (($1::text IS NOT NULL AND id::text LIKE $1 || '%') OR ($2::text IS NOT NULL AND label = $2))", [o.idPrefix ?? null, o.label ?? null]);
  await audit(pool, "invites_revoked", null, { count: r.rowCount });
  return r.rowCount ?? 0;
}

// src/server/hosted/tenants.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync as readdirSync3, rmSync, statSync } from "node:fs";
import { join as join3, resolve, sep } from "node:path";

// src/server/db.ts
import { createRequire } from "node:module";
import { mkdirSync, readFileSync as readFileSync3, readdirSync as readdirSync2, unlinkSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
var Db = class {
  constructor(raw, path) {
    this.raw = raw;
    this.path = path;
  }
  raw;
  path;
  inTx = 0;
  all(sql, ...p) {
    return this.raw.prepare(sql).all(...clean(p));
  }
  get(sql, ...p) {
    return this.raw.prepare(sql).get(...clean(p));
  }
  run(sql, ...p) {
    return this.raw.prepare(sql).run(...clean(p));
  }
  exec(sql) {
    this.raw.exec(sql);
  }
  /** Atomic block; nested calls join the outer transaction. */
  tx(fn) {
    if (this.inTx) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.inTx++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTx--;
    }
  }
  close() {
    this.raw.close();
  }
};
var clean = (p) => p.map((v) => v === void 0 ? null : typeof v === "boolean" ? v ? 1 : 0 : v);
var here2 = dirname2(fileURLToPath2(import.meta.url));
function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const done = new Set(db.all("SELECT version FROM schema_migrations").map((r) => r.version));
  const files = readdirSync2(join2(here2, "migrations")).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    const version = parseInt(f, 10);
    if (done.has(version)) continue;
    const sql = readFileSync3(join2(here2, "migrations", f), "utf8");
    db.tx(() => {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)", version, f, Date.now());
    });
    applied.push(f);
  }
  return applied;
}
function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname2(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  const db = new Db(raw, path);
  migrate(db);
  const now = Date.now();
  db.run("INSERT OR IGNORE INTO profile (id, updated_at) VALUES (1, ?)", now);
  return db;
}

// src/server/hosted/tenants.ts
var ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
var Tenants = class {
  constructor(dir, o = {}) {
    this.dir = dir;
    this.o = o;
    mkdirSync2(join3(dir, "users"), { recursive: true });
  }
  dir;
  o;
  open = /* @__PURE__ */ new Map();
  now() {
    return (this.o.now ?? Date.now)();
  }
  /** Directory of one student's files. The id must look like an id: never a path. */
  userDir(userId) {
    if (!ID_RE.test(userId)) throw new Error("invalid user id");
    const p = resolve(this.dir, "users", userId);
    if (!p.startsWith(resolve(this.dir, "users") + sep)) throw new Error("invalid user id");
    return p;
  }
  key(userId, ws) {
    return `${userId}:${ws}`;
  }
  file(userId, ws) {
    return join3(this.userDir(userId), ws === "demo" ? "demo.db" : "study.db");
  }
  /** Hand out a handle and keep it open until released (an in-flight request may await a slow AI call and still use it afterwards). */
  lease(userId, ws) {
    const k = this.key(userId, ws);
    let e = this.open.get(k);
    if (!e) {
      const db = openDb(this.file(userId, ws));
      recoverOrphans(db);
      e = { db, leases: 0, lastUsed: this.now() };
      this.open.set(k, e);
      this.evict();
    }
    e.leases++;
    e.lastUsed = this.now();
    let released = false;
    return { db: e.db, release: () => {
      if (released) return;
      released = true;
      e.leases--;
      e.lastUsed = this.now();
    } };
  }
  /** Close idle handles beyond the cap, least recently used first. A handle with an in-flight request is never closed. */
  evict() {
    const max = this.o.maxOpen ?? 64;
    if (this.open.size <= max) return;
    const idle = [...this.open.entries()].filter(([, e]) => e.leases === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of idle) {
      if (this.open.size <= max) break;
      e.db.close();
      this.open.delete(k);
    }
  }
  get openCount() {
    return this.open.size;
  }
  hasData(userId) {
    return existsSync3(this.userDir(userId));
  }
  /** Close this student's handles and delete their directory (databases, WAL files, stored uploads). Refuses while a request is in flight. */
  remove(userId) {
    for (const ws of ["real", "demo"]) {
      const e = this.open.get(this.key(userId, ws));
      if (e && e.leases > 0) return false;
    }
    for (const ws of ["real", "demo"]) {
      const k = this.key(userId, ws);
      const e = this.open.get(k);
      if (e) {
        try {
          e.db.close();
        } catch {
        }
        this.open.delete(k);
      }
    }
    rmSync(this.userDir(userId), { recursive: true, force: true });
    return true;
  }
  /** Delete only the sample database of one student (reset). */
  dropDemo(userId) {
    const k = this.key(userId, "demo");
    const e = this.open.get(k);
    if (e) {
      e.db.close();
      this.open.delete(k);
    }
    for (const sfx of ["", "-wal", "-shm"]) rmSync(this.file(userId, "demo") + sfx, { force: true });
  }
  listUserIds() {
    const root = join3(this.dir, "users");
    return existsSync3(root) ? readdirSync3(root).filter((n) => ID_RE.test(n) && statSync(join3(root, n)).isDirectory()) : [];
  }
  /** Total bytes of one student's data (for the storage quota). */
  usageBytes(userId) {
    const dir = this.userDir(userId);
    if (!existsSync3(dir)) return 0;
    return readdirSync3(dir).reduce((a, f) => a + statSync(join3(dir, f)).size, 0);
  }
  closeAll() {
    for (const e of this.open.values()) {
      try {
        e.db.close();
      } catch {
      }
    }
    this.open.clear();
  }
};

// src/server/hosted/backup.ts
import { createCipheriv, createDecipheriv, createHash as createHash2, randomBytes, scryptSync } from "node:crypto";
import { copyFileSync, existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync4, readdirSync as readdirSync4, renameSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
var TABLES = ["app_settings", "invites", "user", "account", "session", "verification", "ai_requests", "usage_counters", "audit_log", "reports"];
var MAGIC = Buffer.from("SHBK1");
var enc = (data, pass) => {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", scryptSync(pass, salt, 32), iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
};
var dec = (blob, pass) => {
  if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error("This file is not an encrypted backup (or the passphrase is needed).");
  const salt = blob.subarray(5, 21), iv = blob.subarray(21, 33), tag = blob.subarray(33, 49);
  const d = createDecipheriv("aes-256-gcm", scryptSync(pass, salt, 32), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(blob.subarray(49)), d.final()]);
  } catch {
    throw new Error("Wrong passphrase, or the backup file was modified.");
  }
};
var sha = (b) => createHash2("sha256").update(b).digest("hex");
var q = (name) => `"${name.replace(/"/g, '""')}"`;
async function backup(o) {
  if (existsSync4(o.destDir) && readdirSync4(o.destDir).length) throw new Error("The backup folder is not empty. Choose a new folder.");
  mkdirSync3(join4(o.destDir, "users"), { recursive: true });
  const put = (rel, data) => {
    const out = o.passphrase ? enc(data, o.passphrase) : data;
    const p = join4(o.destDir, rel);
    mkdirSync3(dirname3(p), { recursive: true });
    writeFileSync(p, out);
    return { sha256: sha(out), bytes: out.length };
  };
  const dump = {};
  const tables = [];
  const c = await o.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const t of TABLES) {
      const r = await c.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${q(t)} t`);
      dump[t] = r.rows[0].rows;
      tables.push({ name: t, rows: r.rows[0].rows.length });
    }
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const control = put("control.json", Buffer.from(JSON.stringify(dump)));
  const users = [];
  for (const id of o.tenants.listUserIds()) {
    const lease = o.tenants.lease(id, "real");
    try {
      const tmp = join4(o.destDir, "users", `${id}.snapshot`);
      lease.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const data = readFileSync4(tmp);
      rmSync2(tmp);
      const meta = put(`users/${id}/study.db`, data);
      users.push({ id, file: `users/${id}/study.db`, ...meta });
    } finally {
      lease.release();
    }
  }
  const manifest = { format: "study-helper-backup", version: 1, createdAt: new Date(o.now()).toISOString(), dataLabel: o.dataLabel, encrypted: !!o.passphrase, tables, control: { file: "control.json", sha256: control.sha256 }, users };
  writeFileSync(join4(o.destDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
async function verifyBackup(dir, passphrase) {
  const m = JSON.parse(readFileSync4(join4(dir, "manifest.json"), "utf8"));
  if (m.format !== "study-helper-backup" || m.version !== 1) throw new Error("Not a Study Helper backup.");
  if (m.encrypted && !passphrase) throw new Error("This backup is encrypted: a passphrase is required.");
  for (const f of [m.control, ...m.users]) if (sha(readFileSync4(join4(dir, f.file))) !== f.sha256) throw new Error(`Backup file ${f.file} is damaged or was modified.`);
  return m;
}
async function restore(o) {
  const m = await verifyBackup(o.bundleDir, o.passphrase);
  if (m.dataLabel !== o.dataLabel) throw new Error(`This backup is from "${m.dataLabel}" and this server is "${o.dataLabel}". Refusing to restore across environments.`);
  const open = (rel) => {
    const b = readFileSync4(join4(o.bundleDir, rel));
    return m.encrypted ? dec(b, o.passphrase) : b;
  };
  const dump = JSON.parse(open(m.control.file).toString("utf8"));
  const existing = (await o.pool.query('SELECT COUNT(*)::int n FROM "user"')).rows[0].n;
  if (existing > 0) throw new Error("Refusing to restore: this deployment already has accounts. Restore into a new, empty database and data folder.");
  let rows = 0;
  await tx(o.pool, async (c) => {
    for (const t of [...TABLES].reverse()) if (t !== "app_settings") await c.query(`DELETE FROM ${q(t)}`);
    await c.query("DELETE FROM app_settings WHERE key <> $1", ["data_label"]);
    for (const t of TABLES) {
      const list = dump[t] ?? [];
      if (!list.length) continue;
      await c.query(`INSERT INTO ${q(t)} SELECT * FROM jsonb_populate_recordset(NULL::${q(t)}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);
      rows += list.length;
    }
  });
  for (const u of m.users) {
    const dest = join4(o.dataDir, "users", u.id, "study.db");
    mkdirSync3(dirname3(dest), { recursive: true });
    for (const sfx of ["-wal", "-shm"]) rmSync2(dest + sfx, { force: true });
    const tmp = `${dest}.restoring`;
    writeFileSync(tmp, open(u.file));
    renameSync(tmp, dest);
  }
  return { users: m.users.length, rows };
}

// src/server/hosted/account.ts
import { createRequire as createRequire2 } from "node:module";
import { mkdirSync as mkdirSync4 } from "node:fs";
import { join as join5 } from "node:path";

// src/server/services/portability.ts
import { z as z2 } from "zod";

// src/core/sources.ts
var ADDRESSEE = /\b(?:ai|a\.i\.|assistant|llm|language\s+model|chatbot|gpt|claude|grader|grading\s+(?:system|ai|model|assistant))\b/i;
var IGNORE_PREV = /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)/i;
var RULES2 = [
  { id: "note-to-grader", severity: "strong", re: /\b(?:note|message|instruction|notice)s?\s+(?:to|for)\s+(?:the\s+)?(?:grader|grading\s+(?:system|ai|model|assistant)|ai(?:\s+assistant)?|a\.i\.|assistant|llm|language\s+model)\b/i },
  { id: "award-full-marks", severity: "strong", re: /\baward\s+(?:full|maximum|max|top)\s+(?:marks|credit|points)\b/i },
  { id: "disregard-rubric", severity: "strong", re: /\bdisregard\s+(?:the\s+|all\s+)?(?:rubric|grading\s+(?:rules|criteria)|previous\s+instructions)\b/i },
  { id: "labelled-system-order", severity: "strong", re: /(?:^|\n)[ \t]*(?:important\s+|urgent\s+)?(?:system|admin|developer)\s+(?:instruction|prompt|override|message)s?\s*:/i },
  { id: "role-switch", severity: "strong", re: /\byou\s+are\s+now\s+(?:in\s+)?(?:a\s+|an\s+|the\s+)?(?:teacher|developer|admin|debug|unrestricted|grader)\b/i },
  // an imperative "Ignore all previous instructions" (start of a sentence/quote) addressed to an AI; dialogue and "tells an AI to ignore…" stay weak
  { id: "ignore-previous-to-ai", severity: "strong", re: new RegExp(`(?:^|[.:!?"\u201C(]\\s*|\\bplease\\s+)${IGNORE_PREV.source}`, "im"), also: ADDRESSEE },
  { id: "ignore-previous", severity: "weak", re: IGNORE_PREV },
  { id: "you-are-now", severity: "weak", re: /\byou\s+are\s+now\b/i },
  { id: "system-wording", severity: "weak", re: /\bsystem\s+(?:instruction|prompt|message|override)/i },
  { id: "new-instructions", severity: "weak", re: /\bnew\s+instructions?\s*:/i },
  { id: "output-only", severity: "weak", re: /\boutput\s+(?:no\s+other|only)\b/i },
  { id: "do-not-reveal", severity: "weak", re: /\bdo\s+not\s+(?:mention|reveal|tell)\s+(?:this|these)\b/i }
];

// src/core/relation.ts
var STEP = 1 / 32;

// src/core/retrieval.ts
var STOP = new Set("a an the of and or to in on for with is are was were be by as at it this that from which what how why do does your you i".split(" "));

// src/core/grounding.ts
var STOP2 = new Set("about above after again also because been before being between both could does doing during each from have having here into just like made make many more most much must only other over same should some such than that their them then there these they this those through under until very what when where which while will with would your you are was were the and for not but can its it's".split(" "));

// src/core/calendar.ts
var ACADEMIC_TYPE_LABEL = {
  homework: "Homework",
  test: "Test",
  quiz: "Quiz",
  project: "Project",
  presentation: "Presentation",
  other_deadline: "Other deadline"
};

// src/server/services/items.ts
var TYPES = Object.keys(ACADEMIC_TYPE_LABEL);

// src/server/services/readingPlan.ts
var DAY2 = 24 * 36e5;

// src/server/services/portability.ts
var FORMAT = "study-helper-export";
var VERSION = 1;
var Row = z2.record(z2.string(), z2.any());
var Learning = z2.object({
  subjects: z2.array(Row).default([]),
  sources: z2.array(Row).default([]),
  concepts: z2.array(Row).default([]),
  concept_refs: z2.array(Row).default([]),
  concept_prereqs: z2.array(Row).default([]),
  questions: z2.array(Row).default([]),
  attempts: z2.array(Row).default([]),
  misconceptions: z2.array(Row).default([]),
  misconception_evidence: z2.array(Row).default([]),
  annotations: z2.array(Row).default([]),
  reading_prompts: z2.array(Row).default([]),
  outlines: z2.array(Row).default([])
});
var ExportFile = z2.object({
  format: z2.literal(FORMAT),
  version: z2.number().int().max(VERSION),
  exportedAt: z2.number(),
  workspace: z2.enum(["real", "demo"]).optional(),
  sections: z2.object({
    profile: z2.object({ name: z2.string().max(60), grade: z2.string().max(30), timezone: z2.string().max(60), default_minutes: z2.number(), about: z2.string().max(600) }).optional(),
    settings: z2.record(z2.string(), z2.any()).optional(),
    memories: z2.array(z2.object({ id: z2.string(), kind: z2.enum(["student_stated", "observed", "ai_inferred"]), text: z2.string().max(400), subject_id: z2.string().nullable().optional(), concept_id: z2.string().nullable().optional(), provenance: z2.any().optional() })).optional(),
    learning: Learning.optional(),
    items: z2.array(Row).optional()
  })
});

// src/server/pdf.ts
var LIMITS = { maxPdfBytes: 15 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024, maxPages: 60, maxChars: 15e4, timeoutMs: 3e4 };

// src/server/hosted/account.ts
var { DatabaseSync: DatabaseSync2 } = createRequire2(import.meta.url)("node:sqlite");
var MB = 1024 * 1024;
async function deleteAccount(o) {
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    removed = o.tenants.remove(o.userId);
    if (!removed) await new Promise((r) => setTimeout(r, 250));
  }
  if (!removed) throw new HttpError(409, "busy", "Something is still running on your account. Wait a few seconds and try again.");
  await tx(o.pool, async (c) => {
    const email = (await c.query('SELECT email FROM "user" WHERE id = $1', [o.userId])).rows[0]?.email;
    await c.query("UPDATE ai_requests SET user_id = NULL WHERE user_id = $1", [o.userId]);
    await c.query("DELETE FROM usage_counters WHERE user_id = $1", [o.userId]);
    await c.query("DELETE FROM reports WHERE user_id = $1", [o.userId]);
    await c.query("UPDATE audit_log SET user_id = NULL WHERE user_id = $1", [o.userId]);
    await c.query("UPDATE invites SET used_by = NULL WHERE used_by = $1", [o.userId]);
    await c.query('DELETE FROM session WHERE "userId" = $1', [o.userId]);
    await c.query('DELETE FROM account WHERE "userId" = $1', [o.userId]);
    if (email) await c.query("DELETE FROM verification WHERE identifier = $1", [email]);
    await c.query('DELETE FROM "user" WHERE id = $1', [o.userId]);
  });
  await audit(o.pool, "account_deleted", null, {});
}
function importLocalDatabase(o) {
  const lease = o.tenants.lease(o.userId, "real");
  const has2 = lease.db.get("SELECT COUNT(*) n FROM subjects").n > 0;
  lease.release();
  if (has2 && !o.replace) throw new HttpError(409, "not_empty", "This account already has study data. Use --replace to overwrite it.");
  o.tenants.remove(o.userId);
  const dir = o.tenants.userDir(o.userId);
  mkdirSync4(dir, { recursive: true });
  const src = new DatabaseSync2(o.file, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${join5(dir, "study.db").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  const l2 = o.tenants.lease(o.userId, "real");
  const n = l2.db.get("SELECT COUNT(*) n FROM attempts").n;
  l2.release();
  return { attempts: n };
}

// src/server/ops/cli.ts
loadEnvFile();
var [cmd, ...rest] = process.argv.slice(2);
var flag = (name, d) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : d;
};
var has = (name) => rest.includes(`--${name}`);
var HELP = `Study Helper operator commands
  invites create --count 5 --label "cohort 1" --days 7   print new single-use codes (shown once; send them yourself)
  invites list | invites revoke --label "cohort 1" | --id <prefix>
  pilot on|off                  the whole site (off: every student sees a pause message; data is untouched)
  signups open|pause            allow / stop NEW accounts (invitations stay valid)
  ai on|off                     switch the paid study assistant on/off for everyone
  max-users <n>                 cap on accounts
  status                        switches, account count, spend in the last 24h (no content)
  reports                       problem reports students chose to send
  user delete --email <email>   delete one student's account and data (on their request)
  user import-local --email <email> --from ./data/study.db [--replace]   move a pre-hosting local database into that student's account
  backup --to <new folder> [--passphrase-env VAR]   restore --from <folder> [--passphrase-env VAR]   verify --from <folder>
  retention                     delete audit events older than 180 days and reports marked done older than 90 days`;
async function main() {
  if (!cmd || cmd === "help") return console.log(HELP);
  const { cfg, problems } = hostedConfigFromEnv();
  if (!cfg.databaseUrl) throw new Error("DATABASE_URL is not set.");
  const pool = createPool(cfg.databaseUrl, { max: 3, ssl: /sslmode=require/.test(cfg.databaseUrl) });
  await migrateControl(pool);
  const dataDir = process.env.DATA_DIR ?? "./data";
  mkdirSync5(dataDir, { recursive: true });
  const now = Date.now();
  const pass = (varName) => varName ? process.env[varName] : void 0;
  try {
    const sub = rest[0];
    if (cmd === "invites" && sub === "create") {
      const codes = await createInvites(pool, { count: Number(flag("count", "1")), label: flag("label", ""), ttlDays: Number(flag("days", "7")), now });
      console.log(`Created ${codes.length} single-use invitation code(s). They are shown ONCE. Send each to one person yourself:
`);
      codes.forEach((c) => console.log("  " + c));
      console.log(`
They expire in ${flag("days", "7")} days. The sign-up page is ${cfg.publicUrl || "(set PUBLIC_URL)"}/#/join`);
    } else if (cmd === "invites" && sub === "list") {
      console.table(await listInvites(pool, now));
    } else if (cmd === "invites" && sub === "revoke") {
      console.log(`Revoked ${await revokeInvites(pool, { idPrefix: flag("id"), label: flag("label") })} unused invitation(s).`);
    } else if (cmd === "pilot" || cmd === "signups" || cmd === "ai") {
      const key = cmd === "pilot" ? "pilot_enabled" : cmd === "signups" ? "signups_open" : "ai_enabled";
      const on = sub === "on" || sub === "open";
      if (!["on", "off", "open", "pause"].includes(sub)) throw new Error(HELP);
      await setSettingPg(pool, key, on);
      await audit(pool, `switch_${key}`, null, { value: on });
      console.log(`${key} = ${on}`);
    } else if (cmd === "max-users") {
      await setSettingPg(pool, "pilot_max_users", Number(sub));
      console.log(`pilot_max_users = ${Number(sub)}`);
    } else if (cmd === "status") {
      const hasUsers = (await pool.query(`SELECT to_regclass('public."user"') AS t`)).rows[0].t !== null;
      const n = hasUsers ? (await pool.query('SELECT COUNT(*)::int n FROM "user"')).rows[0].n : 0;
      console.log(JSON.stringify({ environment: cfg.environment, dataLabel: await getSettingPg(pool, "data_label", null), pilot_enabled: await getSettingPg(pool, "pilot_enabled", false), signups_open: await getSettingPg(pool, "signups_open", true), ai_enabled: await getSettingPg(pool, "ai_enabled", true), max_users: await getSettingPg(pool, "pilot_max_users", 30), accounts: n, config: problems.length ? { problems } : "ok", spend: await spendReport(pool, now) }, null, 2));
    } else if (cmd === "reports") {
      console.table((await pool.query("SELECT id, created_at, status, message, attachment IS NOT NULL AS has_attachment FROM reports ORDER BY created_at DESC LIMIT 50")).rows);
    } else if (cmd === "user" && sub === "delete") {
      const email = flag("email")?.toLowerCase();
      if (!email) throw new Error("--email is required");
      const r = (await pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0];
      if (!r) throw new Error("No such account.");
      await deleteAccount({ pool, tenants: new Tenants(dataDir), userId: r.id, now: () => now });
      console.log("Account and data deleted.");
    } else if (cmd === "user" && sub === "import-local") {
      const email = flag("email")?.toLowerCase(), from = flag("from");
      if (!email || !from) throw new Error("--email and --from are required");
      const r = (await pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0];
      if (!r) throw new Error("No such account: the student must sign in once first.");
      const out = importLocalDatabase({ tenants: new Tenants(dataDir), userId: r.id, file: from, replace: has("replace") });
      await audit(pool, "local_data_imported", r.id, {});
      console.log(`Imported (${out.attempts} saved answers).`);
    } else if (cmd === "backup") {
      const to = flag("to");
      if (!to) throw new Error("--to <new folder> is required");
      const m = await backup({ pool, tenants: new Tenants(dataDir), destDir: to, dataLabel: cfg.dataLabel, passphrase: pass(flag("passphrase-env")), now: () => now });
      console.log(`Backup written to ${to}: ${m.users.length} student database(s), ${m.tables.reduce((a, t) => a + t.rows, 0)} shared rows, ${m.encrypted ? "encrypted" : "NOT encrypted (keep it private)"}.`);
    } else if (cmd === "verify") {
      const m = await verifyBackup(flag("from"), pass(flag("passphrase-env")));
      console.log(`Backup OK: made ${m.createdAt}, ${m.users.length} student database(s).`);
    } else if (cmd === "restore") {
      const r = await restore({ pool, dataDir, bundleDir: flag("from"), dataLabel: cfg.dataLabel, passphrase: pass(flag("passphrase-env")) });
      console.log(`Restored ${r.users} student database(s) and ${r.rows} shared rows. Restart the app, then check /readyz.`);
    } else if (cmd === "retention") {
      const a = await pool.query("DELETE FROM audit_log WHERE at < now() - interval '180 days'");
      const b = await pool.query("DELETE FROM reports WHERE status = 'done' AND created_at < now() - interval '90 days'");
      console.log(`Deleted ${a.rowCount} audit events and ${b.rowCount} old reports.`);
    } else console.log(HELP);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
