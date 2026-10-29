# Pilot responsibilities — what is known and what is not

This is engineering input, **not legal advice**. Nothing here claims compliance with any law.

## Facts checked (third-party sources; primary pages not reachable from the build environment unless stated)
- **Anthropic consumer products require users to be 18+** (secondary sources: [Claude.ai terms summary](https://conductatlas.com/platform/anthropic/claudeai-terms-of-service/minimum-age-and-coppa-compliance/), [guide](https://aitoolsforkids.com/blog/how-old-to-use-claude-ai)). The API is under separate commercial terms; I could **not** confirm what they say about minors using an app built on the API. **Action:** read Anthropic's current Commercial Terms / usage policy for education, and ask Anthropic if the pilot includes under‑18 students.
- **COPPA (under 13, US).** The FTC's 2025 amendments took effect and the proposed school-authorization provisions were *not* finalized; FTC guidance on school authorization remains (FAQ section N, not retrieved) ([Federal Register notice](https://www.govinfo.gov/content/pkg/FR-2025-04-22/html/2025-05904.htm); commentary: [Wiley](https://wiley.law/alert-FTC-Adopts-Amended-Childrens-Online-Protection-Act-Rule)). Practical rule for this pilot: **no students under 13**, unless a school or lawyer has set up valid consent.
- FERPA, state student-privacy laws, and your school's vendor-approval rules may apply once a school is involved. Not assessed.
- A school email address does not prove school authorisation; the invitation list is the only gate, and you control it.

## What the app already does
Invitation-only; closed by default; stores only an email address; no ads, no analytics, no model training on the app's side; students can export and delete their data; assistant calls send only the material needed for that question; per-student and global spend limits. Study text goes to the AI provider when the assistant is on (the privacy notice says so). Homework and uploaded files are private to the student.

## Open items for the operator
1. Age range and provider terms (above). 2. Who the "operator" is legally, a contact address, retention you can honour (audit 180 days, reports 90). 3. Whether the school must approve/contract. 4. Breach-notification duties. 5. Parent/guardian information. 6. Accessibility review beyond the automated keyboard/mobile checks.

## Cost estimate (assumptions, **unconfirmed third-party figures**)
Render prices below come from search results ([Render pricing page via search](https://render.com/pricing.md), [Render article](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)); Postgres figures conflicted between sources — verify on render.com before buying.
- Web service Starter ≈ $7/mo; disk ≈ $0.25/GB/mo (5 GB ≈ $1.25); Postgres basic ≈ $6–7/mo + ~$0.30/GB. **Production only ≈ $15–17/mo; with staging ≈ $30–35/mo.**
- AI: capped by your settings. Defaults: $0.30/student/day and $5/day global ⇒ worst case $150/month; typical use is a small fraction. Real per-request cost has not been measured (live tests blocked).
- Load measured (mock AI, one laptop-class sandbox): 30 simultaneous students, 63 req/s average, p95 186 ms, no server errors except the mock running out of distinct questions. Not a capacity promise for a Starter instance (0.5 CPU, 512 MB).
