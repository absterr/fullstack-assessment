import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { createOrder, getProduct } from "../api";
import { useCart } from "../state/CartContext";
import type { Product } from "../types";
import { fromCents, toCents } from "../utils/money";

export default function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { add } = useCart();
  const [product, setProduct] = useState<Product | null>(null);
  const [isBuying, setBuying] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getProduct(id)
      .then(setProduct)
      .catch((err) => setFetchError(err.message));
  }, [id]);

  async function handleBuyNow() {
    if (!product || isBuying) return;

    // Client-side stock check, enforced on the backend
    if (quantity > product.stock) {
      setBuyError(`Only ${product.stock} in stock`);
      return;
    }

    setBuying(true);
    setBuyError(null);

    try {
      const totalAmount = fromCents(toCents(Number(product.price)) * quantity);

      const order = await createOrder({
        customerId: "customer_001",
        items: [{ productId: product.id, quantity }],
        totalAmount,
      });
      navigate(`/orders/${order.id}`);
    } catch (err) {
      setBuyError(
        err instanceof Error ? err.message : "Failed to create order",
      );
    } finally {
      setBuying(false);
    }
  }

  if (fetchError) return <p className="error">{fetchError}</p>;
  if (!product) return <p>Loading...</p>;

  const isOutOfStock = product.stock === 0;

  return (
    <div className="page">
      <h1>{product.name}</h1>
      <p className="sku">{product.sku}</p>
      {/* Plain text rendering — no HTML in descriptions */}
      <p className="description">{product.description}</p>
      <p className="price">${product.price}</p>
      <p className="stock">
        {isOutOfStock ? "Out of stock" : `${product.stock} in stock`}
      </p>
      <div className="qty-row">
        <input
          type="number"
          min={1}
          max={product.stock}
          value={quantity}
          onChange={(e) =>
            setQuantity(Math.max(1, Math.floor(Number(e.target.value))))
          }
        />
      </div>
      {buyError && <p className="error">{buyError}</p>}
      <div className="actions">
        <button onClick={() => add(product, quantity)} disabled={isOutOfStock}>
          Add to cart
        </button>
        <button
          onClick={handleBuyNow}
          className="primary"
          disabled={isOutOfStock || isBuying}
        >
          {isBuying ? "Placing order..." : "Buy now"}
        </button>
      </div>
    </div>
  );
}
