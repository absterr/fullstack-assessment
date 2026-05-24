import { useEffect, useState } from "react";
import { listOrdersAdmin, listProducts, updateProductAdmin } from "../api";
import type { Order, Product } from "../types";

export default function AdminPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Record<number, Partial<Product>>>({});
  const [saving, setSaving] = useState<Record<number, boolean>>({});
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<Record<number, string>>({});
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [fetchedOrders, fetchedProducts] = await Promise.all([
          listOrdersAdmin(),
          listProducts(),
        ]);
        setOrders(fetchedOrders);
        setProducts(fetchedProducts);
      } catch (err) {
        const isUnauthorized =
          (err instanceof Error && err.message === "No admin token found") ||
          (err instanceof Error && (err as any).status === 401);

        if (isUnauthorized) {
          setUnauthorized(true);
        } else {
          setFetchError(
            err instanceof Error ? err.message : "Failed to load admin data",
          );
        }
      }
    }
    fetchData();
  }, []);

  function onChangeField(id: number, field: keyof Product, value: string) {
    setEditing((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  }

  async function save(p: Product) {
    const draft = editing[p.id] || {};

    // Validate price and stock before submitting
    if (draft.price !== undefined) {
      const price = Number(draft.price);
      if (Number.isNaN(price) || price < 0.01) {
        setSaveError((prev) => ({
          ...prev,
          [p.id]: "Price must be a valid number >= 0.01",
        }));
        return;
      }
    }

    if (draft.stock !== undefined) {
      const stock = Math.floor(Number(draft.stock));
      if (!Number.isInteger(stock) || stock < 0) {
        setSaveError((prev) => ({
          ...prev,
          [p.id]: "Stock must be a non-negative integer",
        }));
        return;
      }
    }

    setSaving((prev) => ({ ...prev, [p.id]: true }));
    setSaveError((prev) => ({ ...prev, [p.id]: "" }));

    try {
      const updated = await updateProductAdmin(p.id, {
        price: draft.price !== undefined ? Number(draft.price) : undefined,
        stock: draft.stock !== undefined ? Number(draft.stock) : undefined,
        description: draft.description as string | undefined,
        name: draft.name as string | undefined,
      });
      // Update state only after API confirms success
      setProducts((current) =>
        current.map((it) => (it.id === updated.id ? updated : it)),
      );
      setEditing((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
    } catch (err) {
      setSaveError((prev) => ({
        ...prev,
        [p.id]: err instanceof Error ? err.message : "Save failed",
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [p.id]: false }));
    }
  }

  if (unauthorized) {
    return (
      <div className="page">
        <h1>Unauthorized</h1>
        <p>Admin token not found. Please configure your admin token.</p>
      </div>
    );
  }

  if (fetchError) return <p className="error">{fetchError}</p>;

  return (
    <div className="page">
      <h1>Admin</h1>
      <section>
        <h2>Orders</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Customer</th>
              <th>Total</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.id}</td>
                <td>{o.customerId}</td>
                <td>${o.totalAmount}</td>
                <td>{o.status}</td>
                <td>{new Date(o.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Products</h2>
        <ul className="admin-products">
          {products.map((p) => (
            <li key={p.id} className="admin-product">
              <input
                type="text"
                defaultValue={p.name}
                onChange={(e) => onChangeField(p.id, "name", e.target.value)}
              />
              <input
                type="number"
                defaultValue={p.price}
                min={0.01}
                step={0.01}
                onChange={(e) => onChangeField(p.id, "price", e.target.value)}
              />
              <input
                type="number"
                defaultValue={String(p.stock)}
                min={0}
                step={1}
                onChange={(e) => onChangeField(p.id, "stock", e.target.value)}
              />
              <textarea
                defaultValue={p.description}
                onChange={(e) =>
                  onChangeField(p.id, "description", e.target.value)
                }
              />
              {saveError[p.id] && <p className="error">{saveError[p.id]}</p>}
              <button onClick={() => save(p)} disabled={saving[p.id]}>
                {saving[p.id] ? "Saving..." : "Save"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
