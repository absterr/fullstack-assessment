# Findings

## Backend

---

### Issue: Stock race condition (concurrency)

- **Where:** `backend/src/services/ordersService.js` — `createOrder`, stock check and `decrementStock` calls
- **Why:** `decrementStock` was called outside any DB transaction. The `withTransaction` helper existed but was never used.
- **Impact:** Concurrent orders could read the same stock value, both pass the stock check, and each decrement independently — resulting in overselling.
- **Fix:** Wrapped the entire `createOrder` flow in `withTransaction`. Stock is now read with `SELECT FOR UPDATE` via `getProductByIdForUpdate`, locking the row for the duration of the transaction. No concurrent transaction can read or modify that row until committed.
- **Trade-offs:** Row-level locking increases contention under very high concurrency. A queue-based reservation system would scale better but is out of scope.

---

### Issue: Non-atomic order creation

- **Where:** `backend/src/services/ordersService.js` — `createOrder`, stock decrement before order insert
- **Why:** Stock decrement and order creation ran as separate queries with no wrapping transaction.
- **Impact:** If `ordersRepository.createOrder` failed after stock was decremented, stock would be permanently reduced with no corresponding order.
- **Fix:** Both operations now run inside the same `withTransaction` block. If the order insert fails, the transaction rolls back and stock is restored.
- **Trade-offs:** None significant.

---

### Issue: Item deduplication and deadlock prevention missing in `createOrder`

- **Where:** `backend/src/services/ordersService.js` — `createOrder`, item processing loop
- **Why:** No deduplication of items before locking. Duplicate productIds in the same payload could lock the same row twice. No consistent lock ordering meant concurrent transactions locking the same rows in different orders risked deadlocks.
- **Impact:** Duplicate items could double-count stock and totals. Inconsistent lock ordering under concurrent load could cause deadlocks.
- **Fix:** Items are deduplicated into a `Map` before the transaction. The resulting unique items are sorted ascending by `productId` before locking, ensuring a consistent lock order across all transactions.
- **Trade-offs:** Merging quantities for duplicate productIds may surprise callers who expect per-line validation.

---

### Issue: Idempotency key written after payment, missing NX flag

- **Where:** `backend/src/services/ordersService.js` — `chargeOrder`, Redis write
- **Why:** Cache was written after payment processing as a logging step, not a guard. `NX` flag was omitted.
- **Impact:** A crash before the cache write would allow a retry to re-invoke the gateway and create a duplicate charge. Without `NX`, a later retry could overwrite a previously stored successful response.
- **Fix:** Cache is checked before any work begins. It is written only after all DB commits succeed, using `NX` so it cannot overwrite an existing successful result.
- **Trade-offs:** A crash between the DB commit and the Redis write leaves a narrow retry window. A distributed transaction log would eliminate this entirely.

---

### Issue: Double-charge race condition in `chargeOrder`

- **Where:** `backend/src/services/ordersService.js` — `chargeOrder`, status check before gateway call
- **Why:** The status check and gateway charge were not atomic. Two concurrent requests could both pass the `PENDING` check before either marked the order paid.
- **Impact:** The same order could be charged twice.
- **Fix:** `getOrderByIdForUpdate` locks the order row inside the transaction. Status is re-checked under the lock before the gateway call.
- **Trade-offs:** Same contention trade-off as the stock race fix.

---

### Issue: Gateway `chargedAmount` trusted blindly

- **Where:** `backend/src/services/ordersService.js` — `chargeOrder`, `createPayment` call
- **Why:** The amount stored in `createPayment` came from the gateway response rather than `order.totalAmount`.
- **Impact:** A compromised or misbehaving gateway could return a different amount which would be persisted as the canonical payment record.
- **Fix:** Server verifies `toCents(gatewayResponse.chargedAmount) === toCents(order.totalAmount)`. Mismatch returns 502 and the transaction rolls back.
- **Trade-offs:** Legitimate partial-charge scenarios (e.g. gateway-applied discounts) would be rejected. No such feature exists in this app.

---

### Issue: Float arithmetic for monetary values

- **Where:** `backend/src/services/ordersService.js` — `createOrder`, `chargeOrder`
- **Why:** `totalAmount` and `unitPrice` were coerced via `Number(...)`. JavaScript's `Number` uses IEEE 754 floating-point which cannot represent all decimal fractions exactly.
- **Impact:** Rounding errors in price calculations (e.g. `0.1 + 0.2 !== 0.3`), potentially causing totalAmount mismatches or incorrect charges.
- **Fix:** All internal money calculations use integer cents via `toCents()` / `fromCents()`. `fromCents` uses `Number((cents / 100).toFixed(2))` to enforce 2-decimal precision. Values are converted back to `NUMERIC(12,2)` only at the storage boundary.
- **Trade-offs:** Safe for this application's value ranges. Very large amounts would need BigInt or a decimal library.

---

### Issue: Client-supplied `totalAmount` trusted

- **Where:** `backend/src/services/ordersService.js` — `createOrder`
- **Why:** The service used the client-provided `totalAmount` directly without server-side verification.
- **Impact:** A tampered request could under-charge by supplying a lower total than the actual sum of items.
- **Fix:** Server recomputes `totalAmount` in cents from DB product prices. Client-supplied value is rejected with 422 if it does not match.
- **Trade-offs:** Strict cent-based equality. Clients pre-calculating totals with float arithmetic may hit mismatch errors.

---

### Issue: Webhook handler not idempotent

- **Where:** `backend/src/services/ordersService.js` — `processPaymentWebhook`
- **Why:** No deduplication check before calling `markOrderAsPaid`. Webhook event was also logged before dedup.
- **Impact:** Provider retries could mark the same order paid multiple times and create duplicate webhook records.
- **Fix:** A Redis `SET NX` lock on `webhook:{providerEventId}` is acquired before any mutation. Duplicate deliveries return `{ accepted: true, deduplicated: true }` immediately. The lock is released on failure so the provider can retry successfully. A DB-level `UNIQUE` constraint on `provider_event_id` provides a secondary guard.
- **Trade-offs:** Redis is the primary dedup store. If Redis is unavailable, webhooks are rejected until it recovers.

---

### Issue: Missing authorization checks

- **Where:** `backend/src/services/ordersService.js` — `createOrder`, `chargeOrder`, `processPaymentWebhook`
- **Why:** No auth middleware exists in the project. Ownership checks were omitted entirely.
- **Impact:** Any caller knowing an `orderId` could charge or query orders they do not own.
- **Fix:** `chargeOrder` now accepts `requestingCustomerId` and returns 403 if the order's `customerId` does not match.
- **Trade-offs:** Incomplete without route-level auth middleware supplying `requestingCustomerId`. Full JWT or session auth is absent from the entire project and is noted as a remaining risk.

---

### Issue: `withTransaction` helper unused

- **Where:** `backend/src/services/ordersService.js` — defined at top of file, never called
- **Why:** Likely an oversight during initial development.
- **Impact:** All critical sections (stock decrement, order creation, charge, webhook processing) ran without transaction protection.
- **Fix:** `withTransaction` is now used in `createOrder`, `chargeOrder`, and `processPaymentWebhook`.
- **Trade-offs:** None.

---

### Issue: No error handling around `paymentGateway.charge`

- **Where:** `backend/src/services/ordersService.js` — `chargeOrder`, gateway call
- **Why:** No try/catch around the external gateway call.
- **Impact:** A gateway failure would abort the function without rolling back side effects or setting an appropriate HTTP status.
- **Fix:** Gateway call is wrapped in try/catch inside the transaction. On failure the transaction rolls back and the idempotency key is not cached, leaving the caller free to retry safely. Status defaults to 502 if not set.
- **Trade-offs:** None significant.

---

### Issue: Inconsistent idempotency cache content

- **Where:** `backend/src/services/ordersService.js` — `chargeOrder`, Redis write
- **Why:** Cache was written before `markOrderAsPaid` in the original code, capturing incomplete state.
- **Impact:** Cached response could reflect a stale order state.
- **Fix:** Cache is written after all DB commits complete, capturing the final `{ order, payment }` state. `NX` ensures the snapshot is immutable once written.
- **Trade-offs:** If an order is later refunded outside this flow, the cached response would be stale for up to 1 hour.

---

### Issue: SQL injection in `listProducts`

- **Where:** `backend/src/repositories/productsRepository.js` — `listProducts`, search query
- **Why:** User-provided `q` was interpolated directly into the SQL string (`WHERE name ILIKE '%${q}%'`).
- **Impact:** An attacker could inject arbitrary SQL, compromising the database.
- **Fix:** Replaced with a parameterized query using `$1`. The `%` wildcards are applied in the JS string passed as the parameter value, which is safe.
- **Trade-offs:** None.

---

### Issue: `getProductByIdForUpdate` missing `FOR UPDATE`

- **Where:** `backend/src/repositories/productsRepository.js` — `getProductByIdForUpdate`
- **Why:** The function name implied a locking read but the query issued a plain `SELECT` with no `FOR UPDATE` clause.
- **Impact:** The stock race condition fix in `ordersService.js` was ineffective — concurrent transactions could still read stale stock.
- **Fix:** Added `FOR UPDATE` to the query. Also updated `createOrder` to call `getProductByIdForUpdate` instead of `getProductById`.
- **Trade-offs:** Must be called inside a transaction; calling it outside will throw.

---

### Issue: `decrementStock` missing stock floor guard

- **Where:** `backend/src/repositories/productsRepository.js` — `decrementStock`
- **Why:** The `UPDATE` had no condition preventing stock from going negative if called directly.
- **Impact:** A direct repository call bypassing the service layer could decrement stock below zero.
- **Fix:** Added `AND stock >= $2` to the `WHERE` clause. Returns `null` if the condition is not met.
- **Trade-offs:** Defence-in-depth only; the service layer already checks stock before calling this.

---

### Issue: Inconsistent `client` parameter across repository functions

- **Where:** `backend/src/repositories/productsRepository.js` — `createProduct`, `updateProduct`
- **Why:** Both functions hard-coded the pool, making them incompatible with transactional callers.
- **Impact:** Calls to `createProduct` or `updateProduct` from within a transaction would use a separate connection, breaking atomicity.
- **Fix:** Both now accept an optional `client` parameter defaulting to `pool`.
- **Trade-offs:** None.

---

### Issue: No pagination on `listProducts` and `listOrders`

- **Where:** `backend/src/repositories/productsRepository.js` — `listProducts`; `backend/src/services/ordersService.js` — `listOrders`
- **Why:** No limit or offset applied to either query.
- **Impact:** Full-table scans on large datasets; potential memory exhaustion and DoS.
- **Fix:** Added `limit` (default 50, max 200) and `offset` parameters to both.
- **Trade-offs:** Callers relying on unbounded results will need to paginate.

---

### Issue: `payments.idempotency_key` nullable and not unique

- **Where:** `backend/src/db/schema.sql` — `payments` table
- **Why:** Column was defined as nullable with no uniqueness constraint.
- **Impact:** Duplicate idempotency keys were possible, breaking idempotent payment behaviour.
- **Fix:** Added `UNIQUE` constraint on `idempotency_key` in the migration.
- **Trade-offs:** Multiple `NULL` values are still permitted under SQL UNIQUE semantics.

---

### Issue: `payments.provider_txn_id` no length limit

- **Where:** `backend/src/db/schema.sql` — `payments` table
- **Why:** Column was defined as `TEXT NOT NULL UNIQUE` with no length constraint.
- **Impact:** A malicious client could insert gigantic strings, causing resource exhaustion.
- **Fix:** Added `CHECK (char_length(provider_txn_id) <= 255)`.
- **Trade-offs:** None for normal provider transaction IDs.

---

### Issue: No `UNIQUE` constraint on `payment_events.provider_event_id`

- **Where:** `backend/src/db/schema.sql` — `payment_events` table
- **Why:** Column had no uniqueness constraint, relying entirely on Redis for dedup.
- **Impact:** If Redis was unavailable, duplicate webhook events could be persisted.
- **Fix:** Added `UNIQUE` constraint as a secondary guard.
- **Trade-offs:** Existing duplicate rows would need cleanup before applying the migration.

---

### Issue: `order_items` allows duplicate line items

- **Where:** `backend/src/db/schema.sql` — `order_items` table
- **Why:** No composite unique constraint on `(order_id, product_id)`.
- **Impact:** The same product could appear twice in one order, double-counting quantities and totals.
- **Fix:** Added `UNIQUE (order_id, product_id)` constraint.
- **Trade-offs:** None; the service layer merges duplicate items before insert.

---

### Issue: No index on `orders.customer_id`

- **Where:** `backend/src/db/schema.sql` — `orders` table
- **Why:** No index defined on a frequently filtered column.
- **Impact:** Queries filtering by customer cause full-table scans, impacting performance at scale.
- **Fix:** Added `CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)`.
- **Trade-offs:** Minor write overhead on order creation.

---

### Issue: `order_items.product_id` missing `ON DELETE RESTRICT`

- **Where:** `backend/src/db/schema.sql` — `order_items` table
- **Why:** Foreign key had no delete rule, defaulting to `NO ACTION`.
- **Impact:** Deleting a product would orphan its order line items, breaking referential integrity.
- **Fix:** Changed to `ON DELETE RESTRICT` to prevent product deletion if order items reference it.
- **Trade-offs:** Admins cannot delete products that have been ordered. A soft-delete (`is_active` flag) would be a better long-term pattern.

---

### Issue: `products.price` check allows sub-cent values

- **Where:** `backend/src/db/schema.sql` — `products` table
- **Why:** `CHECK (price > 0)` allowed values like `0.001`.
- **Impact:** Sub-cent prices break the cent-based arithmetic assumptions in the service layer.
- **Fix:** Changed to `CHECK (price >= 0.01)`.
- **Trade-offs:** None for this application's currency assumptions.

---

### Issue: No validation of required environment variables

- **Where:** `backend/src/config/env.js`
- **Why:** `DATABASE_URL`, `REDIS_URL` were taken as-is with no presence check.
- **Impact:** Missing values would cause runtime failures that leak stack traces rather than failing fast at startup.
- **Fix:** Added `requireEnv(key, required)` which throws a descriptive error at startup if a required variable is missing.
- **Trade-offs:** Optional vars with insecure defaults (`ADMIN_TOKEN`, `WEBHOOK_SECRET`) still start the app without warning.

---

### Issue: `PAYMENT_FAILURE_RATE` NaN on malformed input

- **Where:** `backend/src/config/env.js` — `PAYMENT_FAILURE_RATE` parsing
- **Why:** `Number(process.env.PAYMENT_FAILURE_RATE)` silently produces `NaN` if the value is malformed.
- **Impact:** NaN could propagate into payment calculations, producing incorrect results silently.
- **Fix:** Added `requireNumericEnv(key, defaultValue)` which parses and validates numeric env vars at startup, throwing if the result is `NaN`. Applied to `PORT`, `PAYMENT_FAILURE_RATE`, `PAYMENT_DELAY_MIN_MS`, and `PAYMENT_DELAY_MAX_MS`.
- **Trade-offs:** None significant.

---

### Issue: Insecure defaults for `ADMIN_TOKEN` and `WEBHOOK_SECRET`

- **Where:** `backend/src/config/env.js` — `ADMIN_TOKEN` and `WEBHOOK_SECRET`
- **Why:** Both defaulted to `"change-me"` and `"replace-me"`. Anyone reading the source could authenticate as admin or forge webhooks if the app ran with defaults.
- **Impact:** Full admin access and webhook forgery without any credentials in any environment that forgot to set these vars.
- **Fix:** Both are now enforced as required via `requireEnv`, throwing at startup if not set. No insecure fallback remains.
- **Trade-offs:** Local development requires both vars to be explicitly set in `.env`. The provided `.env.example` should include placeholder guidance for new contributors.
- ***

### Issue: Open CORS policy

- **Where:** `backend/src/app.js` — `cors()` configuration
- **Why:** `origin: "*"` was used as a development convenience.
- **Impact:** Any website could make credentialed requests to the API, widening the attack surface for CSRF and credential theft on admin routes.
- **Fix:** Replaced with `origin: env.FRONTEND_ORIGIN`, defaulting to `http://localhost:5173`.
- **Trade-offs:** Any frontend not matching `FRONTEND_ORIGIN` will be blocked. Intentional.

---

### Issue: No request body size limit

- **Where:** `backend/src/app.js` — `express.json()` middleware
- **Why:** `express.json()` was used with no options.
- **Impact:** Unbounded request bodies could be used for memory exhaustion or DoS.
- **Fix:** Added `limit: "100kb"` to `express.json()`.
- **Trade-offs:** Legitimate large payloads would be rejected. No such endpoint exists in this app.

---

### Issue: No authentication guard on admin routes

- **Where:** `backend/src/app.js` — `/admin` route mounting; `backend/src/routes/adminRoutes.js`
- **Why:** `/admin` was mounted with no middleware. The routes themselves had no token check.
- **Impact:** Anyone could create or update products without authentication.
- **Fix:** Added an auth middleware before the admin router that validates `Authorization: Bearer <token>` against `env.ADMIN_TOKEN`. Returns 401 on missing or invalid token.
- **Trade-offs:** Uses a shared secret rather than JWT. Acceptable given no auth system exists in the project; noted as a remaining risk.

---

### Issue: Error handler exposed internal details on 5xx

- **Where:** `backend/src/app.js` — global error handler
- **Why:** `error.message` was returned for all errors including 500s.
- **Impact:** Internal implementation details (DB errors, stack context) could be exposed to clients.
- **Fix:** 5xx responses now return the generic string `"Internal server error"`. 4xx responses still return `error.message` as those are intentional caller-facing errors.
- **Trade-offs:** Debugging production 5xx errors requires log access rather than response inspection. Correct behaviour.

---

## Remaining Risks

| Risk                                           | Reason not addressed                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Full JWT / session auth middleware             | Entirely absent from the project; would require route-level changes across all endpoints                                       |
| `idempotencyKey` format validation             | Belongs at route validation layer (Zod/Joi); out of scope                                                                      |
| Hardcoded Redis TTLs                           | Low risk for assessment scope; move to env vars in production                                                                  |
| Rate limiting                                  | Requires `express-rate-limit` dependency; out of scope                                                                         |
| Helmet security headers                        | Requires `helmet` dependency; out of scope                                                                                     |
| Unhandled promise rejections in route handlers | All current handlers use try/catch with `next(err)`; a global `asyncWrapper` is a defensive improvement, not an active bug fix |
| Multi-currency support                         | No requirement in spec                                                                                                         |
| Product soft-delete                            | Better pattern than `ON DELETE RESTRICT` but out of scope                                                                      |

---

## Frontend

### Issue: No idempotency key sent on `chargeOrder`

- **Where:** `frontend/src/api.ts` — `chargeOrder`
- **Why:** No `Idempotency-Key` header was sent, so retries on network failure would create duplicate charge attempts.
- **Impact:** Double-charging on transient network failures or user retries.
- **Fix:** `crypto.randomUUID()` is generated client-side per charge attempt and sent as `Idempotency-Key`. The client owns the retry lifecycle — the same key is reused on retries of the same attempt.
- **Trade-offs:** Key is generated per call, not per user action. A retry-aware wrapper would be needed to reuse the key across actual retries.

---

### Issue: No admin token on `listOrdersAdmin`

- **Where:** `frontend/src/api.ts` — `listOrdersAdmin`
- **Why:** `Authorization` header was absent, unlike `updateProductAdmin` which already sent the token.
- **Impact:** Admin order listing would be rejected by the backend auth middleware after it was added.
- **Fix:** Extracted token retrieval into `getAdminToken()` shared by both `listOrdersAdmin` and `updateProductAdmin`. Throws early if no token is found, preventing unnecessary requests.
- **Trade-offs:** Token is read from `localStorage` or `VITE_ADMIN_TOKEN` env var. Storing tokens in `localStorage` is vulnerable to XSS — a `httpOnly` cookie would be more secure but requires backend changes.

---

### Issue: Server-side validation messages lost on error

- **Where:** `frontend/src/api.ts` — `request`
- **Why:** Errors were thrown as generic `new Error(data?.error || res.statusText)` without preserving the HTTP status code.
- **Impact:** Callers could not distinguish 400 from 500, making it harder to display meaningful messages to users.
- **Fix:** Error now includes a `status` property matching `res.status`. Server-side `error` string is preserved as the message when available.
- **Trade-offs:** None significant.

---

### Issue: Float arithmetic for cart totals

- **Where:** `frontend/src/state/CartContext.tsx` — `add`, `total`
- **Why:** `parseFloat(product.price)` was used to store price, and `total` was computed with direct float multiplication.
- **Impact:** Rounding errors in cart totals could cause `totalAmount` mismatches when submitting orders to the backend, resulting in 422 errors.
- **Fix:** Prices are stored in integer cents via `toCents()` on add. Total is computed in cents and converted back via `fromCents()` only at the display/submission boundary. Shared `utils/money.ts` utility used for consistency with the backend.
- **Trade-offs:** `CartItem.price` now stores cents. Any component rendering `item.price` directly must call `fromCents(item.price)` before display.

---

### Issue: No quantity validation on cart add

- **Where:** `frontend/src/state/CartContext.tsx` — `add`
- **Why:** No guard on the `quantity` parameter — zero or negative values could be added.
- **Impact:** Invalid line items could be submitted to the backend, causing unexpected errors or incorrect totals.
- **Fix:** `safeQuantity = Math.max(1, Math.floor(quantity))` applied before any state update.
- **Trade-offs:** None.

---

## Remaining Risks (Frontend)

| Risk                                      | Reason not addressed                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin token stored in `localStorage`      | Vulnerable to XSS. A `httpOnly` cookie requires backend changes; out of scope.                                                                                                                   |
| No retry logic with idempotency key reuse | `chargeOrder` generates a new key per call. A retry-aware wrapper would be needed to reuse the key across actual retries.                                                                        |
| Cart not persisted on page refresh        | UX convenience, not a correctness or security issue. Would require `localStorage` serialization.                                                                                                 |
| Optimistic cart with no stock reservation | Stock is not held when items are added to cart. Backend correctly rejects oversold orders at checkout via `SELECT FOR UPDATE`. No frontend fix is possible without a backend reservation system. |

---

## Cross-cutting

> To be completed.
