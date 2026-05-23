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

// ─── createOrder ─────────────────────────────────────────────────────────────

async function createOrder({ customerId, items, totalAmount }) {
  if (!customerId || !Array.isArray(items) || items.length === 0) {
    const error = new Error("customerId and items are required");
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

async function chargeOrder({ orderId, idempotencyKey }) {
  if (idempotencyKey) {
    const cached = await redis.get(`idem:${idempotencyKey}`);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  const order = await ordersRepository.getOrderById(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }

  if (order.status !== "PENDING") {
    const error = new Error("Only pending orders can be charged");
    error.status = 409;
    throw error;
  }

  const gatewayResponse = await paymentGateway.charge({
    orderId: order.id,
    amount: order.totalAmount,
  });

  const payment = await paymentsRepository.createPayment({
    orderId: order.id,
    amount: gatewayResponse.chargedAmount,
    providerTxnId: gatewayResponse.providerTxnId,
    status: "SUCCESS",
    idempotencyKey,
  });

  const updatedOrder = await ordersRepository.markOrderAsPaid(order.id);

  if (idempotencyKey) {
    await redis.set(
      `idem:${idempotencyKey}`,
      JSON.stringify({ order: updatedOrder, payment }),
      "EX",
      3600,
    );
  }

  return { order: updatedOrder, payment };
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
