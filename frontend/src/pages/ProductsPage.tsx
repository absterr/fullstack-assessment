import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listProducts } from "../api";
import type { Product } from "../types";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(query: string) {
    setLoading(true);
    setFetchError(null);

    try {
      const data = await listProducts(query);
      setProducts(data);
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : "Failed to load products",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(value: string) {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load(value);
    }, 300);
  }

  useEffect(() => {
    load("");
  }, []);

  return (
    <div className="page">
      <h1>Products</h1>
      <div className="toolbar">
        <input
          type="text"
          value={q}
          placeholder="Search products"
          onChange={(e) => {
            handleSearch(e.target.value);
          }}
        />
      </div>
      {loading ? (
        <p>Loading...</p>
      ) : fetchError ? (
        <p>{fetchError}</p>
      ) : products.length === 0 ? (
        <p>No products found</p>
      ) : (
        <ul className="product-grid">
          {products.map((p, idx) => (
            <li key={idx} className="product-card">
              <Link to={`/products/${p.id}`}>
                <h3>{p.name}</h3>
                <p className="sku">{p.sku}</p>
                <p className="price">${p.price}</p>
                <p className="stock">
                  {p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
