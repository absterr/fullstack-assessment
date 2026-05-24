# AI Usage Notes

## 1. Tools used

- Claude Code — codebase exploration, audit, fix generation, code review and documentation
- Zed — code editor

---

## 2. Prompt journal

### Prompt 1

```
Read the [frontend/backend] folder in this project and identify all bugs related to the
investigation priorities in CLAUDE.md. Do not fix anything yet. List each issue
with its file, what it is, and why it's a problem.
```

Model Produced a structured audit table covering the backend and frontend folders.  
Kept the full findings list as the basis for FINDINGS.md. I Rejected the suggested
fix order. I then reordered by severity myself rather than accepting the model's
default top-to-bottom file order.

### Prompt 2

```
Fix [filename] based on the audit findings. For each fix, explain
your reasoning before writing the code.
```

Model Produced a full file rewrite with modifications and additions
I Kept most of it and rejected some changes that introduced bugs after a manual review.

### Prompt 3

```
Modify and review the audit findings and check for any issues not listed.
```

Confirmed all tool-found issues and surfaced 6 additional ones including the
double-charge race, missing providerEventId dedup before DB write, gateway
chargedAmount trusted blindly, and unbounded listOrders. Kept all valid
findings after manual verification.

### Prompt 4

```
Should schema changes go in schema.sql or a separate migration file?
Provide both.
```

Produced a clear split between schema.sql (clean install) and a migration file
(existing DBs), along with both files. Kept the structure and used it to
produce migrations/001_add_constraints.sql as a production deployment
artifact.

### Prompt 5

```
Is [NUMERIC(12,2) with JavaScript float conversions] a concern, based on
our implementation?
```

Model correctly identified that the integer cents pattern eliminates the risk.
I verified independently by tracing every monetary value through the call chain
before accepting the conclusion.

---

## 3. AI got it wrong

### Case 1: `fromCents` returned a raw float

The original suggestion:

```js
function fromCents(cents) {
    return cents / 100;
}
```

This returns an uncontrolled float such as `10.5` instead of `10.50`, and potentially
`10.500000000001` for certain cent values due to IEEE 754 representation.
Unsafe at a money boundary where consistent 2-decimal precision is required.

**How I caught it:** Manually reviewed the generated helpers and caught the issue,
as it's a subtle but popular quirk in JavaScript floating-point arithmetic.

**Fix:** Replaced with:

```js
function fromCents(cents) {
    return Number((cents / 100).toFixed(2));
}
```

`toFixed(2)` enforces precision; `Number()` converts back to numeric for the
repository layer.

### Case 2: Missing `FOR UPDATE` in product row lock

Claude Code generated this in `createOrder`:

```js
// Lock the row so concurrent transactions cannot read stale stock.
const product = await productsRepository.getProductById(item.productId, client);
```

The comment claimed the row was locked, but `getProductById` issues a plain
`SELECT` with no `FOR UPDATE` clause. The overselling bug remained fully intact
despite the comment.

**How I caught it:** Manually reading the repository layer and confirming no
locking clause existed. The solution would have been to just call `getProductByIdForUpdate`
instead. However, `getProductByIdForUpdate` also did not contain `FOR UPDATE`.

**Fix:** Both issues were fixed manually. `createOrder` was updated to use
`getProductByIdForUpdate`, and `getProductByIdForUpdate` was updated to include `FOR UPDATE`.

### Case 3: `redis.set` NX flag omitted on idempotency cache

The model's first version of `chargeOrder` wrote the idempotency cache without
the `NX` flag:

```js
await redis.set(
    `idem:${idempotencyKey}`,
    JSON.stringify({ order: updatedOrder, payment }),
    "EX",
    3600,
);
```

Without `NX`, a race between two concurrent requests completing near-simultaneously
could overwrite a previously stored successful response with a later result.
The model's own explanation of idempotency described this risk correctly, yet
the generated code did not guard against it.

**How I caught it:** Cross-referencing the Redis `SET` documentation and
comparing against the stated fix description.

**Fix:** Added `"NX"` as the final argument.

### Case 4: Frontend error handling

The model used a single shared `error` state throughout both `ProductDetailPage`
and `OrderDetailPage`. A failed action would replace the entire page with an
error message, losing the user's context entirely.

**How I caught it:** Reviewing the generated JSX and reasoning through the UX
implications. A payment failure on `OrderDetailPage` would unmount the order
view, leaving the user with no way to retry or see the order status.

**Fix:** Split into separate states: `fetchError` and `buyError`/`payError`.
Fetch failures replace the page since there is nothing to render. Action failures
display inline, preserving the page. Also added `max={product.stock}` on the
quantity input for HTML-level clamping, and `err instanceof Error` checks for
safe error extraction instead of `any` casting.

### Case 5: Idempotency key generated per call, not per attempt

The model's initial `chargeOrder` implementation in `api.ts` generated a new
`crypto.randomUUID()` on every call:

```ts
const idempotencyKey = crypto.randomUUID();
```

This means a retry after a network failure would send a different key, causing
the backend to treat it as a fresh charge rather than a duplicate. The
idempotency guarantee was present in name only.

**How I caught it:** I reasoned through the retry lifecycle. A new key on every
call means no retry protection at all. The model's own comment stated "reuse
this key on retries" but the implementation made that impossible.

**Fix:** Key is now generated once per attempt and stored in component state
(`idempotencyKey` in `OrderDetailPage`, `checkoutKey` in `CartPage`). Reused
on retries, cleared on success or when the order leaves `PENDING` state.
`chargeOrder` and `createOrder` in `api.ts` now accept an optional
`idempotencyKey` parameter, falling back to `crypto.randomUUID()` only when
not provided.

---

## 4. Validation strategy

- **Manual code review** of every AI-generated function against the repository
  layer it calls. This is how both errors in section 3 were caught
- **Call chain tracing** for all monetary values. I followed every `price`,
  `totalAmount`, and `chargedAmount` from DB read through service logic to
  storage to confirm no float arithmetic occurred outside `toCents`/`fromCents`
- **SQL review** Read every query directly, including checking clause ordering
  (caught `LIMIT` before `ORDER BY` in `listProducts`)
- **Cross-referencing Redis SET documentation** for `NX` / `EX` option semantics
- **Cross-referencing PostgreSQL FOR UPDATE documentation** to confirm lock
  scope and transaction behaviour

---

## 5. What you did NOT delegate

### Money handling

Did not delegate the decision to use integer cents arithmetic. The model
suggested `toCents`/`fromCents` which I adopted, but I independently verified
the `fromCents` implementation (`Number((cents / 100).toFixed(2))`) by tracing
edge cases manually. I also made the call to reject client-supplied `totalAmount`
and recompute server-side.

### Concurrency and locking

Did not trust the model's lock placement without verification. The model
generated code with a comment claiming a row was locked when it was not
(section 3, case 1). I checked the repository layer directly for every
`FOR UPDATE` claim. Lock strategy (locking product rows before stock check,
locking order rows before charge) was reasoned through independently against
PostgreSQL transaction isolation documentation.

### Authorization

The model proposed an ownership check in `chargeOrder` via `requestingCustomerId`.
I accepted the pattern but noted independently that it is incomplete without
auth middleware supplying the value. The model did not flag this gap
unprompted. I made the decision to document this as a remaining risk rather than
implement a full JWT.
