import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { chargeOrder, getOrder } from "../api";
import type { Order } from "../types";

export default function OrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [isPaying, setPaying] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!id) return;

    function fetchOrder() {
      getOrder(id!)
        .then((o) => {
          setOrder(o);
          // Stop polling once order reaches a terminal state
          if (o.status !== "PENDING") {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
          }
        })
        .catch((err) => setFetchError(err.message));
    }

    fetchOrder();
    intervalRef.current = setInterval(fetchOrder, 2000);

    // Cleanup on unmount
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [id]);

  async function handlePay() {
    if (!order || isPaying) return;

    setPaying(true);
    setPayError(null);

    try {
      const result = await chargeOrder(order!.id);
      setOrder(result.order);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setPaying(false);
    }
  }

  if (fetchError) return <p>{fetchError}</p>;
  if (!order) return <p>Loading order...</p>;

  return (
    <div className="page">
      <h1>Order #{order.id}</h1>
      <p>
        Status: <span className={`status ${order.status}`}>{order.status}</span>
      </p>
      <p>Total: ${order.totalAmount}</p>
      <h2>Items</h2>
      <ul>
        {(order.items || []).map((item, idx) => (
          <li key={idx}>
            {item.name} x {item.quantity} @ ${item.unitPrice}
          </li>
        ))}
      </ul>

      <h2>Payments</h2>
      {(order.payments || []).length === 0 && <p>No payments yet.</p>}
      <ul>
        {(order.payments || []).map((p, idx) => (
          <li key={idx}>
            {p.status} - ${p.amount} ({p.providerTxnId})
          </li>
        ))}
      </ul>

      {payError && <p className="error">{payError}</p>}
      {order.status === "PENDING" && (
        <button className="primary" onClick={handlePay} disabled={isPaying}>
          {isPaying ? "Charging..." : "Pay now"}
        </button>
      )}
    </div>
  );
}
