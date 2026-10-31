# No-sign-in mode

Set AUTH_GUESTS=1 and open pilot admissions using the existing operator controls. The staging and production Blueprints enable it. Existing deployments keep their current behavior until explicitly enabled. Production Google credentials are optional; only add them if offering account sign-in.

Continue without an account creates a random server identity with a secure session cookie. No email, password, Google account or invitation is requested. Each guest uses the same isolated storage, rate limits, AI spending ledger, global budget and deletion/export controls as an account user. Guest creation respects the pilot pause, admissions switch and total user capacity. Guests count toward that capacity. Clearing cookies can create another identity and reset per-user quotas; the global spend ceiling and address-based authentication limits remain essential. This mode is unsuitable as a way to enforce one allocation per person.

Guest work persists across ordinary browser visits while the session remains valid (SESSION_DAYS, seven days by default). Leaving, cookie removal or expiry loses access. Work is not automatically deleted or migrated to an account. Export and delete it before leaving. Operators must manage abandoned guest data and capacity; automatic guest retention cleanup is not implemented. No-sign-in does not make submitted schoolwork anonymous to the host or AI provider. The privacy notice and existing launch review still apply.

Guest Google Calendar connections are rejected. Assignments and tests can be entered manually. Optional account users retain their existing Calendar behavior. No site has been deployed by this change.

Validation: hostedGuests.test.ts exercises real Better Auth and PostgreSQL for guest entry, isolation, export/deletion, admission limits, and disabled-by-default behavior. The full CI suite must pass before staging.
