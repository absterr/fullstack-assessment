// Jest tests for paymentsRepository
// Verify SQL queries and returned rows for payment operations.

const pool = require("../db/postgres");
const paymentsRepository = require("./paymentsRepository");

jest.mock("../db/postgres");

describe("paymentsRepository.createPayment", () => {
  it("inserts payment and returns created row", async () => {
    const mockPayment = { id: 10, orderId: 1, amount: 15.0 };
    pool.query.mockResolvedValue({ rows: [mockPayment] });
    const payment = await paymentsRepository.createPayment({
      orderId: 1,
      amount: 15.0,
      providerTxnId: "txn-1",
      status: "SUCCESS",
      idempotencyKey: "key-1",
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO payments"), [1, 15.0, "txn-1", "SUCCESS", "key-1"]);
    expect(payment).toEqual(mockPayment);
  });
});

describe("paymentsRepository.findPaymentByIdempotencyKey", () => {
  it("returns payment when key exists", async () => {
    const mock = { id: 11 };
    pool.query.mockResolvedValue({ rows: [mock] });
    const result = await paymentsRepository.findPaymentByIdempotencyKey("key-2");
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("WHERE idempotency_key"), ["key-2"]);
    expect(result).toBe(mock);
  });
  it("returns null when not found", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await paymentsRepository.findPaymentByIdempotencyKey("missing");
    expect(result).toBeNull();
  });
});

describe("paymentsRepository.createWebhookEvent", () => {
  it("inserts webhook event and returns the row", async () => {
    const mock = { id: 20, providerEventId: "evt-1" };
    pool.query.mockResolvedValue({ rows: [mock] });
    const event = await paymentsRepository.createWebhookEvent({
      providerEventId: "evt-1",
      orderId: 2,
      eventType: "payment_succeeded",
      payload: { foo: "bar" },
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO payment_events"), ["evt-1", 2, "payment_succeeded", { foo: "bar" }]);
    expect(event).toBe(mock);
  });
});
