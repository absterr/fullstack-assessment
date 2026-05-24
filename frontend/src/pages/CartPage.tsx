import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createOrder } from "../api";
import { useCart } from "../state/CartContext";
import { fromCents } from "../utils/money";

export default function CartPage() {
  const { items, total, remove, clear } = useCart();
  const navigate = useNavigate();
  const [isChecking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    if (items.length === 0 || isChecking) return;

    setChecking(true);
    setError(null);

    try {
      const order = await createOrder({
        customerId: "customer_001",
        items: items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
        })),
        totalAmount: total,
      });
      clear();
      navigate(`/orders/${order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
    } finally {
      setChecking(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="page">
        <h1>Cart</h1>
        <p>Your cart is empty.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Cart</h1>
      <ul className="cart-list">
        {items.map((item) => (
          <li key={item.productId} className="cart-item">
            <span>{item.name}</span>
            <span>
              {item.quantity} x ${fromCents(item.price)}
            </span>
            <span>${fromCents(item.price * item.quantity)}</span>
            <button onClick={() => remove(item.productId)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="cart-total">
        <strong>Total:</strong> ${total}
      </div>
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={checkout} disabled={isChecking}>
        {isChecking ? "Placing order..." : "Checkout"}
      </button>
    </div>
  );
}
