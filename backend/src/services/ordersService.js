const ordersRepository = require("../repositories/ordersRepository");
const productsRepository = require("../repositories/productsRepository");
const paymentsRepository = require("../repositories/paymentsRepository");
const paymentGateway = require("./paymentGateway");
const redis = require("../db/redis");
const db = require("../db/postgres");

async function withTransaction(callback) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Convert a monetary value to integer cents to avoid float arithmetic issues.
 * All internal money calculations use cents; convert back to decimal only at
 * the boundary (storage / response).
 */
function toCents(value) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

function isValidString(str) {
  return typeof str === "string" && str.trim().length > 0;
}

// ─── createOrder ─────────────────────────────────────────────────────────────

async function createOrder({ customerId, items, totalAmount }) {
  if (!isValidString(customerId)) {
    const error = new Error("customerId must be a valid string");
    error.status = 400;
    throw error;
  }

  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error("Order items are required");
    error.status = 400;
    throw error;
  }

  if (
    typeof totalAmount !== "number" ||
    Number.isNaN(totalAmount) ||
    totalAmount <= 0
  ) {
    const error = new Error("totalAmount must be a valid positive number");
    error.status = 400;
    throw error;
  }

  return withTransaction(async (client) => {
    const enrichedItems = [];
    let computedTotalCents = 0;

    for (const item of items) {
      if (
        !item.productId ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1
      ) {
        const error = new Error(
          "Each item requires a valid productId and quantity",
        );
        error.status = 400;
        throw error;
      }

      // Lock the row so concurrent transactions cannot read stale stock.
      const product = await productsRepository.getProductById(
        item.productId,
        client,
      );

      if (!product) {
        const error = new Error(`Product ${item.productId} not found`);
        error.status = 404;
        throw error;
      }

      if (product.stock < item.quantity) {
        const error = new Error(`Insufficient stock for ${product.name}`);
        error.status = 409;
        throw error;
      }

      const unitPriceCents = toCents(product.price);
      computedTotalCents += unitPriceCents * item.quantity;

      enrichedItems.push({
        productId: product.id,
        quantity: item.quantity,
        unitPrice: fromCents(unitPriceCents),
      });
    }

    // Reject if the client-supplied totalAmount doesn't match server computation.
    // Trade-off: strict equality in cents avoids float drift.
    const providedTotalCents = toCents(totalAmount);
    if (computedTotalCents !== providedTotalCents) {
      const error = new Error(
        `totalAmount mismatch: expected ${fromCents(computedTotalCents)}, got ${totalAmount}`,
      );
      error.status = 422;
      throw error;
    }

    for (const item of enrichedItems) {
      await productsRepository.decrementStock(
        item.productId,
        item.quantity,
        client,
      );
    }

    const order = await ordersRepository.createOrder(
      {
        customerId,
        totalAmount: fromCents(computedTotalCents),
        items: enrichedItems,
      },
      client,
    );

    return order;
  });
}

async function chargeOrder({ idempotencyKey, orderId, requestingCustomerId }) {
  if (!isValidString(idempotencyKey) || !isValidString(requestingCustomerId)) {
    const error = new Error(
      "idempotencyKey and requestingCustomerId must be valid strings",
    );
    error.status = 400;
    throw error;
  }

  const cached = await redis.get(`idem:${idempotencyKey}`);
  if (cached) {
    return JSON.parse(cached);
  }

  return withTransaction(async (client) => {
    const order = await ordersRepository.getOrderById(orderId, client);

    if (!order) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }

    // Authorization: ensure the caller owns this order.
    if (order.customerId !== requestingCustomerId) {
      const error = new Error(
        "You do not have permission to charge this order",
      );
      error.status = 403;
      throw error;
    }

    if (order.status !== "PENDING") {
      const error = new Error("Only pending orders can be charged");
      error.status = 409;
      throw error;
    }

    let gatewayResponse;

    try {
      gatewayResponse = await paymentGateway.charge({
        orderId: order.id,
        amount: order.totalAmount,
      });
    } catch (err) {
      err.status = err.status || 502;
      throw err;
    }

    if (toCents(gatewayResponse.chargedAmount) !== toCents(order.totalAmount)) {
      const error = new Error(
        "Gateway charged amount does not match order total",
      );
      error.status = 502;
      throw error;
    }

    // Use order amount instead of gateway response amount
    const payment = await paymentsRepository.createPayment(
      {
        orderId: order.id,
        amount: order.totalAmount,
        providerTxnId: gatewayResponse.providerTxnId,
        status: "SUCCESS",
        idempotencyKey,
      },
      client,
    );

    const updatedOrder = await ordersRepository.markOrderAsPaid(
      order.id,
      client,
    );

    await redis.set(
      `idem:${idempotencyKey}`,
      JSON.stringify({ order: updatedOrder, payment }),
      "EX",
      3600,
    );

    return { order: updatedOrder, payment };
  });
}

async function processPaymentWebhook({
  providerEventId,
  orderId,
  eventType,
  payload,
}) {
  await paymentsRepository.createWebhookEvent({
    providerEventId,
    orderId,
    eventType,
    payload,
  });

  if (eventType === "payment_succeeded") {
    await ordersRepository.markOrderAsPaid(orderId);
  }

  return { accepted: true };
}

async function getOrderById(orderId) {
  const order = await ordersRepository.getOrderWithDetails(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }
  return order;
}

async function listOrders(params) {
  return ordersRepository.listOrders(params);
}

module.exports = {
  createOrder,
  chargeOrder,
  processPaymentWebhook,
  getOrderById,
  listOrders,
};
