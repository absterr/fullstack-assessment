// Jest tests for ordersRepository
// Verify SQL queries are constructed correctly and results are returned as expected.

const pool = require("../db/postgres");
const ordersRepository = require("./ordersRepository");

jest.mock("../db/postgres");

// ─── createOrder ─────────────────────────────────────────────────────────────

describe("ordersRepository.createOrder", () => {
  it("inserts order and order items, returns the created order", async () => {
    const mockOrder = {
      id: 1,
      customerId: "cust1",
      totalAmount: "20.00",
      status: "PENDING",
    };

    const mockClient = {
      query: jest.fn(),
    };

    // First call: INSERT INTO orders
    mockClient.query.mockResolvedValueOnce({ rows: [mockOrder] });
    // Second call: INSERT INTO order_items (one item)
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const order = await ordersRepository.createOrder(
      {
        customerId: "cust1",
        totalAmount: 20.0,
        items: [{ productId: 1, quantity: 2, unitPrice: 10.0 }],
      },
      mockClient,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO orders"),
      ["cust1", 20.0],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO order_items"),
      [mockOrder.id, 1, 2, 10.0],
    );
    expect(order).toEqual(mockOrder);
  });

  it("inserts multiple order items for multiple items", async () => {
    const mockOrder = {
      id: 2,
      customerId: "cust2",
      totalAmount: "30.00",
      status: "PENDING",
    };
    const mockClient = { query: jest.fn() };

    mockClient.query.mockResolvedValueOnce({ rows: [mockOrder] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    await ordersRepository.createOrder(
      {
        customerId: "cust2",
        totalAmount: 30.0,
        items: [
          { productId: 1, quantity: 1, unitPrice: 10.0 },
          { productId: 2, quantity: 2, unitPrice: 10.0 },
        ],
      },
      mockClient,
    );

    // One order insert + two item inserts
    expect(mockClient.query).toHaveBeenCalledTimes(3);
  });
});

// ─── listOrders ───────────────────────────────────────────────────────────────

describe("ordersRepository.listOrders", () => {
  it("applies limit and offset parameters", async () => {
    const rows = [{ id: 1 }];
    pool.query.mockResolvedValue({ rows });
    const result = await ordersRepository.listOrders({ limit: 5, offset: 2 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT"),
      [5, 2],
    );
    expect(result).toBe(rows);
  });

  it("uses defaults when no params provided", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await ordersRepository.listOrders();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT"),
      [50, 0],
    );
  });
});

// ─── getOrderById ─────────────────────────────────────────────────────────────

describe("ordersRepository.getOrderById", () => {
  it("returns order when found", async () => {
    const order = { id: 2 };
    pool.query.mockResolvedValue({ rows: [order] });
    const result = await ordersRepository.getOrderById(2);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1"),
      [2],
    );
    expect(result).toBe(order);
  });

  it("returns null when not found", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await ordersRepository.getOrderById(999);
    expect(result).toBeNull();
  });
});

// ─── getOrderByIdForUpdate ────────────────────────────────────────────────────

describe("ordersRepository.getOrderByIdForUpdate", () => {
  it("uses provided client and includes FOR UPDATE clause", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 3 }] }),
    };
    const result = await ordersRepository.getOrderByIdForUpdate(3, client);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      [3],
    );
    expect(result).toEqual({ id: 3 });
  });

  it("returns null when order not found", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const result = await ordersRepository.getOrderByIdForUpdate(999, client);
    expect(result).toBeNull();
  });
});

// ─── markOrderAsPaid ─────────────────────────────────────────────────────────

describe("ordersRepository.markOrderAsPaid", () => {
  it("updates status to PAID and returns updated row", async () => {
    const updated = { id: 4, status: "PAID" };
    pool.query.mockResolvedValue({ rows: [updated] });
    const result = await ordersRepository.markOrderAsPaid(4);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders"),
      [4],
    );
    expect(result).toBe(updated);
  });

  it("uses provided client when given", async () => {
    const updated = { id: 5, status: "PAID" };
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [updated] }),
    };
    const result = await ordersRepository.markOrderAsPaid(5, client);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders"),
      [5],
    );
    expect(result).toBe(updated);
  });

  it("returns null when order not found", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await ordersRepository.markOrderAsPaid(999);
    expect(result).toBeNull();
  });
});

// ─── getOrderWithDetails ──────────────────────────────────────────────────────

describe("ordersRepository.getOrderWithDetails", () => {
  it("assembles order with items and payments", async () => {
    const orderRow = { id: 5, customerId: "c5" };
    const items = [{ id: 1, productId: 1 }];
    const payments = [{ id: 2, status: "SUCCESS" }];

    // Promise.all fires all three queries concurrently — use a spy
    // that returns different values based on call order
    pool.query
      .mockResolvedValueOnce({ rows: [orderRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: items })
      .mockResolvedValueOnce({ rows: payments });

    const result = await ordersRepository.getOrderWithDetails(5);

    expect(result).toMatchObject({
      id: 5,
      items,
      payments,
    });
  });

  it("returns null when order is not found", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await ordersRepository.getOrderWithDetails(999);
    expect(result).toBeNull();
  });
});
