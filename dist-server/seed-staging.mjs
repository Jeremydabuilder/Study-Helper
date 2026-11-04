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
}).superRefine((q, ctx) => {
  if (q.kind === "multiple_choice" && (!q.choices || q.correct_choice === void 0 || q.correct_choice >= q.choices.length))
    ctx.addIssue({ code: "custom", message: "multiple_choice needs choices and a valid correct_choice" });
  if (q.kind === "math" && !q.answer) ctx.addIssue({ code: "custom", message: "math needs an answer" });
  if (q.kind !== "multiple_choice" && q.kind !== "math" && !q.rubric) ctx.addIssue({ code: "custom", message: "open questions need a rubric" });
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

// src/ai/groqCapacity.ts
var MAX_COOLDOWN_MS = 6 * 36e5;

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

// src/server/hosted/pg.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
var here = dirname(fileURLToPath(import.meta.url));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));
function createPool(url, o = {}) {
  const pool2 = new pg.Pool({ connectionString: url, max: o.max ?? 10, idleTimeoutMillis: 3e4, connectionTimeoutMillis: 5e3, statement_timeout: 15e3, ssl: o.ssl ? { rejectUnauthorized: true } : void 0 });
  pool2.on("error", () => {
  });
  return pool2;
}
async function tx(pool2, fn) {
  const c = await pool2.connect();
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
async function migrateControl(pool2) {
  const c = await pool2.connect();
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
async function audit(pool2, event, userId, detail = {}) {
  await pool2.query("INSERT INTO audit_log (event, user_id, detail) VALUES ($1,$2,$3)", [event, userId, JSON.stringify(detail)]);
}

// src/server/hosted/limits.ts
var DEFAULT_LIMITS = {
  userDailyRequests: 60,
  userDailyUsd: 0.3,
  globalDailyUsd: 5,
  globalDailyRequests: 0,
  globalDailyTokens: 0,
  userDailyTokens: 0,
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
var ASSUMED_TOKENS = 3e3;
var TOKENS_SQL = `COALESCE(SUM(CASE WHEN status = 'settled' AND input_tokens IS NOT NULL THEN COALESCE(input_tokens,0) + COALESCE(output_tokens,0) WHEN status IN ('reserved','abandoned') OR billing = 'unknown' THEN ${ASSUMED_TOKENS} ELSE 0 END),0)::int`;

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
  const ownerEnabled = g("OWNER_ONLY") === "1";
  const publicUrl = (g("PUBLIC_URL") ?? (g("RAILWAY_PUBLIC_DOMAIN") ? `https://${g("RAILWAY_PUBLIC_DOMAIN")}` : "")).replace(/\/+$/, "");
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
  const oidc = !ownerEnabled && clientId && clientSecret ? {
    providerId: g("AUTH_OIDC_PROVIDER_ID") ?? "google",
    clientId,
    clientSecret,
    authorizationUrl: g("AUTH_OIDC_AUTHORIZATION_URL") ?? GOOGLE.authorizationUrl,
    tokenUrl: g("AUTH_OIDC_TOKEN_URL") ?? GOOGLE.tokenUrl,
    userInfoUrl: g("AUTH_OIDC_USERINFO_URL") ?? GOOGLE.userInfoUrl,
    scopes: ["openid", "email"]
  } : null;
  const ownerEmail = (g("OWNER_EMAIL") ?? "").toLowerCase(), ownerPassword = g("OWNER_PASSWORD");
  const passwordSignIn = ownerEnabled ? true : g("AUTH_PASSWORD") === "1";
  const guestEnabled = ownerEnabled ? false : g("AUTH_GUESTS") === "1";
  if (ownerEnabled) {
    if (g("AUTH_GUESTS") === "1") problems.push("OWNER_ONLY=1 cannot be combined with AUTH_GUESTS=1: an owner-only site has no guest entry.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) problems.push("OWNER_EMAIL must be the email address you sign in with.");
    if (ownerPassword !== null && ownerPassword.length < 12) problems.push("OWNER_PASSWORD must be at least 12 characters.");
  }
  if (!ownerEnabled && !oidc && !passwordSignIn && !guestEnabled) problems.push("Configure at least one sign-in method: Google/OIDC credentials, AUTH_PASSWORD=1, or AUTH_GUESTS=1.");
  if (!ownerEnabled && environment === "production" && passwordSignIn && g("AUTH_PASSWORD_ALLOW_IN_PRODUCTION") !== "1") problems.push("AUTH_PASSWORD=1 is not allowed in production unless AUTH_PASSWORD_ALLOW_IN_PRODUCTION=1 (accounts would then rely on invitations alone).");
  const dataLabel = g("DATA_LABEL") ?? environment;
  const operator = { name: g("OPERATOR_NAME") ?? "", contact: g("OPERATOR_CONTACT") ?? "" };
  if (!ownerEnabled && environment === "production" && (!operator.name || !operator.contact)) problems.push("OPERATOR_NAME and OPERATOR_CONTACT are required in production: the privacy notice must say who runs the site and how to reach them.");
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
    globalConcurrentExtractions: num("LIMIT_GLOBAL_CONCURRENT_EXTRACTIONS", DEFAULT_LIMITS.globalConcurrentExtractions),
    globalDailyRequests: num("LIMIT_GLOBAL_DAILY_AI_REQUESTS", DEFAULT_LIMITS.globalDailyRequests),
    globalDailyTokens: num("LIMIT_GLOBAL_DAILY_TOKENS", DEFAULT_LIMITS.globalDailyTokens),
    userDailyTokens: num("LIMIT_USER_DAILY_TOKENS", DEFAULT_LIMITS.userDailyTokens)
  };
  return { cfg: { environment, databaseUrl: g("DATABASE_URL") ?? "", publicUrl, authSecret, oidc, passwordSignIn, guestEnabled, limits, trustProxy: g("TRUST_PROXY") !== "0", operator, sessionDays: num("SESSION_DAYS", ownerEnabled ? 30 : 7), owner: { enabled: ownerEnabled, email: ownerEmail, password: ownerPassword, name: (g("OWNER_NAME") ?? "Jeremy").slice(0, 40) }, dataLabel, rate: { apiPerMin: num("RATE_API_PER_MIN", 300), authPerMin: num("RATE_AUTH_PER_MIN", 40), invitePerMin: num("RATE_INVITE_PER_MIN", 20) } }, problems };
}

// src/server/hosted/staging.ts
async function prepareStaging(pool2) {
  await tx(pool2, async (c) => {
    await c.query("LOCK TABLE app_settings IN EXCLUSIVE MODE");
    const label = (await c.query("SELECT value FROM app_settings WHERE key = 'data_label'")).rows[0]?.value;
    if (label !== void 0 && label !== "staging") throw new Error("Refusing to seed: this database belongs to another environment.");
    for (const [key, value] of Object.entries({ data_label: "staging", pilot_enabled: true, signups_open: true, pilot_max_users: 10, ai_enabled: false })) {
      await c.query("INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [key, JSON.stringify(value)]);
    }
  });
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
async function createInvites(pool2, o) {
  const count2 = Math.max(1, Math.min(200, Math.floor(o.count)));
  const ttl = Math.max(1, Math.min(60, Math.floor(o.ttlDays ?? 7)));
  const codes = [];
  await tx(pool2, async (c) => {
    for (let i2 = 0; i2 < count2; i2++) {
      const code = newCode();
      codes.push(code);
      await c.query("INSERT INTO invites (code_hash, label, created_at, expires_at) VALUES ($1,$2,$3,$4)", [hashCode(code), (o.label ?? "").slice(0, 60), new Date(o.now), new Date(o.now + ttl * 864e5)]);
    }
  });
  await audit(pool2, "invites_created", null, { count: count2, ttlDays: ttl, label: (o.label ?? "").slice(0, 60) });
  return codes;
}

// scripts/seed-staging.ts
loadEnvFile();
var { cfg } = hostedConfigFromEnv();
if (cfg.environment !== "staging") {
  console.error('Refusing: APP_ENV is not "staging". This script is for the test site only.');
  process.exit(2);
}
if (cfg.dataLabel !== "staging") {
  console.error('Refusing: DATA_LABEL must be "staging".');
  process.exit(2);
}
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
var i = process.argv.indexOf("--count");
var count = i > 0 ? Math.min(20, Math.max(1, Number(process.argv[i + 1]) || 5)) : 5;
var pool = createPool(cfg.databaseUrl, { max: 2, ssl: /sslmode=require/.test(cfg.databaseUrl) });
try {
  await migrateControl(pool);
  await prepareStaging(pool);
  const codes = await createInvites(pool, { count, label: "staging rehearsal", ttlDays: 3, now: Date.now() });
  await audit(pool, "seed_staging", null, { invites: codes.length });
  console.log("Staging is on for up to 10 testers; paid AI is off. Use made-up notes only. Single-use codes (shown once):\n");
  codes.forEach((c) => console.log("  " + c));
} finally {
  await pool.end();
}
