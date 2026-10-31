> **Superseded (2026-10-31).** Both fixes in this note were reviewed and merged into `claude/pilot-integration` (PR #7 and #8). The audit findings and test counts below describe the old base: the findings were resolved by upgrading vite/vitest (`npm audit` reports 0), and the full suite now runs with PostgreSQL required. See `docs/LAUNCH_CHECKLIST.md` for current results.

# Independent production hardening pass

Base: `ae3b9b3d2a0e6f9caba86ba414f97814737b0839`, branch `claude/pilot-integration`.
Changes are isolated on `codex/tenant-cache-production-fix`; no deployment or merge was performed.

## Fixed

- Tenant cache eviction previously ran before the new database handle was leased. If every older handle was busy, eviction could close the new handle immediately, returning a closed database to its request. Acquire the lease before eviction and trim overflow again on release. Active handles remain protected, even with equal timestamps. The new test exercises overflow, continued use, double release, and reopening persisted data without PostgreSQL.
- `audit:prod` previously appended `|| true`, making dependency audit failures pass CI. It now propagates the audit exit status. Do not restore failure suppression to obtain a green build.
- Rebuilt the tracked server/operator bundles to include the handle fix.

## Validation actually run

- Focused tenant/database tests: 3 passed.
- TypeScript typecheck: passed.
- Hosted production build: passed (Node 24.22.1 here; deployment targets Node 22.13).
- Full test run: 366 passed, 3 failed, 56 skipped. Three eval CLI tests fail before executing application code because this runtime refuses the tsx CLI IPC socket (`listen EPERM /tmp/tsx-0/...pipe`). PostgreSQL-dependent tests were skipped because no PostgreSQL instance is configured. These are not claimed as passing.
- Production dependency audit: correctly exits 1; reported 6 findings (3 moderate, 1 high, 2 critical), including Vite/Vitest/tinypool paths. Inspect the actual deployed dependency graph and lockfile, fix or explicitly justify findings, and rerun the gate. The existing pruning script removes test/build packages after bundling, but the current audit still reports them. No forced major-version dependency upgrade was attempted in this isolated fix.

## Claude integration notes

Cherry-pick or review this branch into the active integration work. Avoid replacing concurrent changes. Rebuild tracked bundles after resolving any source conflicts.

Continue the release checklist: PostgreSQL-required CI, browser tests, real staging sign-in, bounded live AI verification, backup restoration and unresolved operator/provider/privacy decisions. This change alone does not establish launch readiness.
