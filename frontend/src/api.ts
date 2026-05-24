import type { Order, Product } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

function getAdminToken(): string {
  const token =
    localStorage.getItem("admin_token") ?? import.meta.env.VITE_ADMIN_TOKEN;

  if (!token) {
    throw new Error("No admin token found");
  }
  return token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Preserve server-side validation messages for caller display
    const message =
      typeof data?.error === "string" ? data.error : res.statusText;
    const error = new Error(message) as Error & { status: number };
    error.status = res.status;

    throw error;
  }
  return data as T;
}

export function listProducts(q?: string): Promise<Product[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<Product[]>(`/products${qs}`);
}

export function getProduct(id: number | string): Promise<Product> {
  return request<Product>(`/products/${id}`);
}

export function createOrder(body: {
  customerId: string;
  items: { productId: number; quantity: number }[];
  totalAmount: number;
}): Promise<Order> {
  return request<Order>("/orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getOrder(id: number | string): Promise<Order> {
  return request<Order>(`/orders/${id}`);
}

export function chargeOrder(orderId: number): Promise<{ order: Order }> {
  /**
  Generate a unique idempotency key per charge attempt.
  The client owns the retry lifecycle. Reuse this key on retries
  */

  const idempotencyKey = crypto.randomUUID();
  return request<{ order: Order }>("/payments/charge", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ orderId }),
  });
}

export function listOrdersAdmin(): Promise<Order[]> {
  return request<Order[]>("/orders", {
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
  });
}

export function updateProductAdmin(
  id: number,
  body: { price?: number; stock?: number; description?: string; name?: string },
): Promise<Product> {
  return request<Product>(`/admin/products/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify(body),
  });
}
