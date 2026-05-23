# Project

Fullstack bug-fix assessment.
Backend: Node/Express/PostgreSQL/Redis. Frontend: React/TypeScript/Vite.
Goal: find and fix logical, security, and UX bugs. Do NOT introduce new features.

# AI Self-awareness

You are known to produce plausible-but-wrong fixes for: monetary arithmetic,
authorization checks, rendering untrusted HTML, and background polling cleanup.
Flag these explicitly and explain your reasoning rather than just outputting code.

# Investigation Priority

1. Concurrency / overselling (DB row locking, race conditions)
2. Idempotency (duplicate webhooks, double-charge, deduplication)
3. Auth / authorization gaps and token storage
4. Money handling (float arithmetic, rounding)
5. XSS / unsafe HTML rendering
6. Frontend stale state, fetch races, optimistic updates, double-submit
7. Error handling and accessibility

# Code Rules

- Production-appropriate fixes only — no hacks or TODOs left in fixed code
- Preserve existing patterns unless the pattern itself is the bug
- Add a comment on any non-obvious fix explaining why it's safe
- Tests required for: concurrency, idempotency, auth, and at least one frontend bug

# Documentation

Maintain a running log in FINDINGS.md as you go — what, why, fix, trade-offs.
Do NOT wait until the end. Log spotted-but-unfixed issues too.
