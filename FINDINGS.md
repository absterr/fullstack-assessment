# FINDINGS.md

## Overview

This document records all issues found in the `fullstack-assessment` codebase, organized by file. Each entry covers what the issue is, why it happens, the fix applied, and any remaining trade-offs.

---

## `backend/src/services/ordersService.js`

---

### [FIXED] #1 · Stock race condition (concurrency)

**What:** `decrementStock` was called outside any DB transaction. Concurrent orders could read the same stock value, both pass the `product.stock < item.quantity` check, and each decrement stock — resulting in overselling.

**Why it happens:** No row-level lock was held between the stock check and the decrement. The `withTransaction` helper existed but was never used.

**Fix:** Wrapped the entire `createOrder` flow in `withTransaction`. Stock is now read with `SELECT FOR UPDATE` via `getProductByIdForUpdate`, locking the row for the duration of the transaction. No concurrent transaction can read or modify that row until the lock is released.

**Trade-offs:** Row-level locking increases contention under very high concurrency. A queue-based reservation system would scale better but is out of scope here.

---

### [FIXED] #2 · Non-atomic order creation

**What:** `createOrder` decremented stock first, then created the order. If `ordersRepository.createOrder` failed, stock was permanently reduced with no corresponding order.

**Why it happens:** The two operations ran as separate queries with no wrapping transaction.

**Fix:** Both the stock decrement and order creation now run inside the same `withTransaction` block. If the order insert fails, the transaction rolls back and stock is restored.

**Trade-offs:** None significant. This is the correct pattern.

---

### [FIXED] #3 · Idempotency key written after payment, no NX flag

**What:** The idempotency cache was written _after_ the payment was processed. If the process crashed before `redis.set`, a retry would re-invoke the payment gateway and create a duplicate charge. Additionally, `redis.set` lacked the `NX` flag, so a later retry could overwrite a previously stored successful response.

**Why it happens:** The cache write was treated as a logging step rather than a guard.

**Fix:** Cache is checked before any work begins. It is written only after all DB commits succeed, using `NX` so it cannot overwrite an existing successful result.

**Trade-offs:** A crash between the DB commit and the Redis write still leaves a narrow retry window. Acceptable for this scope; a distributed transaction log would eliminate it entirely.

---

### [FIXED] #4 · Missing authorization checks

**What:** `createOrder`, `chargeOrder`, and `processPaymentWebhook` accepted `customerId`/`orderId` without verifying the caller is allowed to act on that resource.

**Why it happens:** No auth middleware exists in the project; ownership checks were omitted entirely.

**Fix:** `chargeOrder` now accepts a `requestingCustomerId` parameter and returns 403 if the order's `customerId` does not match. Route-level auth middleware is a remaining gap (see below).

**Trade-offs:** Full auth requires JWT or session middleware wired to all routes — not implemented as it is absent from the entire project. Noted in FINDINGS as a remaining risk.

---

### [FIXED] #5 · Float arithmetic for monetary values

**What:** `totalAmount` and `unitPrice` were coerced via `Number(...)` and stored directly. Floating-point arithmetic on monetary values causes rounding errors (e.g. `0.1 + 0.2 !== 0.3`).

**Why it happens:** JavaScript's `Number` type uses IEEE 754 floating-point, which cannot represent all decimal fractions exactly.

**Fix:** All internal money calculations use integer cents via `toCents()` / `fromCents()`. Values are converted back to `NUMERIC(12,2)` only at the storage boundary.

**Trade-offs:** `fromCents` returns `Number((cents / 100).toFixed(2))` — this is safe for values within the range of this application but would need BigInt or a decimal library for very large amounts.

---

### [FIXED] #6 · Client-supplied `totalAmount` trusted

**What:** The API accepted the caller's `totalAmount` field without verifying it matched the server-computed sum of `unitPrice × quantity`. A tampered request could under-charge.

**Why it happens:** The service used the client value directly.

**Fix:** Server recomputes `totalAmount` in cents from product prices fetched from the DB. If the client-supplied value does not match, a 422 is returned.

**Trade-offs:** Clients that pre-calculate totals will now receive errors on floating-point rounding differences. The cent-based comparison is strict by design.

---

### [FIXED] #7 · Inconsistent idempotency cache content

**What:** The cached response included the order object but not a stable snapshot. A stale cache could return an order that had since transitioned state (e.g. `PENDING` → `FAILED`).

**Why it happens:** Cache was written with incomplete state.

**Fix:** Cache is now written after `markOrderAsPaid` completes, capturing the final `{ order, payment }` state. The `NX` flag ensures this snapshot is immutable once written.

**Trade-offs:** If an order is later cancelled or refunded outside this flow, the cached response would be stale for up to 1 hour. Acceptable given the TTL.

---

### [FIXED] #8 · Webhook handler not idempotent

**What:** `processPaymentWebhook` called `markOrderAsPaid` on every `payment_succeeded` event with no deduplication, allowing the same order to be marked paid multiple times on provider retries.

**Why it happens:** No dedup check before the state mutation.

**Fix:** A Redis `SET NX` lock on `webhook:{providerEventId}` is acquired before any mutation. Duplicate deliveries return `{ accepted: true, deduplicated: true }` immediately. The lock is released on failure so the provider can retry successfully.

**Trade-offs:** Redis is the dedup store; if Redis is unavailable, webhooks are rejected. A DB-level unique constraint on `provider_event_id` (added in schema migration) provides a secondary guard.

---

### [FIXED] #9 · `withTransaction` helper unused

**What:** The helper was defined but never called, leaving all critical sections unprotected.

**Why it happens:** Likely an oversight during initial development.

**Fix:** `withTransaction` is now used in `createOrder`, `chargeOrder`, and `processPaymentWebhook`.

**Trade-offs:** None.

---

### [FIXED] #10 · No error handling around `paymentGateway.charge`

**What:** If the gateway threw, the function aborted without rolling back side effects (e.g. a partially cached idempotency key).

**Why it happens:** No try/catch around the gateway call.

**Fix:** Gateway call is wrapped in try/catch inside the transaction. On failure the transaction rolls back and the idempotency key is not cached, leaving the caller free to retry safely.

**Trade-offs:** None significant.

---

### [FIXED] #11 · `redis.set` without `NX`

**What:** The idempotency cache write did not use `NX`, so a race could overwrite a previously stored successful response with a later failed one.

**Why it happens:** `NX` was omitted from the `redis.set` call.

**Fix:** All idempotency `redis.set` calls now include `NX`.

**Trade-offs:** None.

---

### [NOTED, NOT FIXED] #12 · No input sanitization for `idempotencyKey`

**What:** The key is taken verbatim and used as a Redis key. A malicious client could supply special characters or a very long value, risking key injection or memory exhaustion.

**Why not fixed:** Sanitization belongs at the route validation layer (e.g. enforce UUID format with a schema validator like Zod or Joi). Not addressed here to avoid scope creep into the route layer.

**Recommendation:** Validate `idempotencyKey` as a UUID v4 at the route level before it reaches the service.

---

### [FIXED] #13 · `chargeOrder` ownership not checked at service level

**What:** Any caller could charge any order by knowing its ID, even if route-level auth existed.

**Fix:** `chargeOrder` now accepts `requestingCustomerId` and returns 403 on mismatch.

**Trade-offs:** Requires callers to pass `requestingCustomerId`; incomplete without auth middleware supplying it.

---

### [FIXED] #14 · Double-charge race condition in `chargeOrder`

**What:** The status check and gateway charge were not atomic. Two concurrent requests could both pass the `PENDING` check before either marked the order paid.

**Why it happens:** No row-level lock on the order between status check and charge.

**Fix:** `getOrderByIdForUpdate` locks the order row inside the transaction. Status is re-checked under the lock.

**Trade-offs:** Same contention trade-off as #1.

---

### [FIXED] #15 · `processPaymentWebhook` logs event before dedup

**What:** `createWebhookEvent` was called before any deduplication check, creating duplicate webhook records on retries.

**Fix:** Redis `NX` dedup check runs first. The event is only written to the DB after the lock is acquired.

**Trade-offs:** None significant.

---

### [FIXED] #16 · Gateway `chargedAmount` trusted blindly

**What:** The amount stored in `paymentsRepository.createPayment` came from the gateway response, not `order.totalAmount`. A compromised gateway could return a different amount.

**Fix:** Server verifies `toCents(gatewayResponse.chargedAmount) === toCents(order.totalAmount)`. Mismatch returns 502.

**Trade-offs:** Legitimate partial-charge scenarios (e.g. discounts applied by gateway) would be rejected. Acceptable given no such feature exists here.

---

### [NOTED, NOT FIXED] #17 · Hardcoded idempotency TTL

**What:** 3600s is hardcoded with no configurability. May be too short for retries hours later.

**Recommendation:** Move to an environment variable (e.g. `IDEMPOTENCY_TTL_SECONDS`).

---

### [FIXED] #18 · Unbounded `listOrders`

**What:** No pagination or limit, potentially returning the entire orders table.

**Fix:** Default limit 50, hard cap 200, with `offset` support.

**Trade-offs:** Callers relying on unbounded results will need to paginate.

## `backend/src/repositories/productsRepository.js`

---

### [FIXED] #19 · SQL injection in `listProducts`

**What:** The search query interpolated user-provided `q` directly into the SQL string (`WHERE name ILIKE '%${q}%'`), enabling arbitrary SQL injection.

**Why it happens:** String interpolation used instead of parameterized queries.

**Fix:** Replaced with a parameterized query using `$1` placeholder. The `%` wildcards are applied in the JS string passed as the parameter value, which is safe.

**Trade-offs:** None.

---

### [FIXED] #20 · `getProductByIdForUpdate` missing `FOR UPDATE`

**What:** The function was named to imply a locking read but did not include `FOR UPDATE`, making it ineffective for preventing concurrent stock modifications.

**Fix:** Added `FOR UPDATE` to the query.

**Trade-offs:** Must be called inside a transaction; calling it outside will throw.

---

### [FIXED] #21 · `decrementStock` missing stock floor guard

**What:** The `UPDATE` could decrement stock below zero if called outside the service-layer stock check (e.g. via a direct repository call).

**Fix:** Added `AND stock >= $2` to the `WHERE` clause. Returns `null` if the condition is not met, which the service layer treats as an error.

**Trade-offs:** Defence-in-depth only; the service layer already checks stock before calling this.

---

### [FIXED] #22 · Inconsistent `client` parameter across repository functions

**What:** `createProduct` and `updateProduct` hard-coded the pool, making them incompatible with transactional callers.

**Fix:** Both now accept an optional `client` parameter defaulting to `pool`.

**Trade-offs:** None.

---

### [FIXED] #23 · No pagination on `listProducts`

**What:** Returned the entire products table with no limit.

**Fix:** Added `limit` (default 50, max 200) and `offset` parameters, consistent with `listOrders`.

**Trade-offs:** Same as #18.

---

### [NOTED, NOT FIXED] #24 · XSS via product `name`/`description` fields

**What:** The repository returns raw text fields. If rendered unescaped in the frontend, a malicious product name could inject script tags.

**Why not fixed here:** Sanitization belongs at the frontend render layer. React escapes text content by default; the risk is only present if `dangerouslySetInnerHTML` is used.

**Recommendation:** Audit frontend rendering of product fields (see frontend findings).
