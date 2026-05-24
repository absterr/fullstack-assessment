// Route-level tests for admin auth middleware
// Proves that /admin routes are protected by the Bearer token check
// mounted in app.js, and that valid tokens are accepted.

const request = require("supertest");
const app = require("../app");
const productsRepository = require("./repositories/productsRepository");

jest.mock("./repositories/productsRepository");
jest.mock("./config/env", () => ({
  ADMIN_TOKEN: "test-admin-token",
  FRONTEND_ORIGIN: "http://localhost:5173",
}));

// ─── Admin auth middleware ────────────────────────────────────────────────────

describe("Admin auth middleware", () => {
  describe("POST /admin/products", () => {
    const validProduct = {
      sku: "SKU-001",
      name: "Test Product",
      description: "A product",
      price: 9.99,
      stock: 10,
    };

    beforeEach(() => {
      jest.clearAllMocks();
      productsRepository.createProduct.mockResolvedValue({
        id: 1,
        ...validProduct,
      });
    });

    it("returns 401 when no Authorization header is provided", async () => {
      const res = await request(app).post("/admin/products").send(validProduct);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 when Authorization header has wrong token", async () => {
      const res = await request(app)
        .post("/admin/products")
        .set("Authorization", "Bearer wrong-token")
        .send(validProduct);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
      const res = await request(app)
        .post("/admin/products")
        .set("Authorization", "test-admin-token")
        .send(validProduct);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 201 when valid Bearer token is provided", async () => {
      const res = await request(app)
        .post("/admin/products")
        .set("Authorization", "Bearer test-admin-token")
        .send(validProduct);
      expect(res.status).toBe(201);
      expect(productsRepository.createProduct).toHaveBeenCalled();
    });
  });

  describe("PATCH /admin/products/:id", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      productsRepository.updateProduct.mockResolvedValue({
        id: 1,
        name: "Updated",
        price: "19.99",
        stock: 5,
      });
    });

    it("returns 401 when no token is provided", async () => {
      const res = await request(app)
        .patch("/admin/products/1")
        .send({ price: 19.99 });
      expect(res.status).toBe(401);
    });

    it("returns 200 when valid token is provided", async () => {
      const res = await request(app)
        .patch("/admin/products/1")
        .set("Authorization", "Bearer test-admin-token")
        .send({ price: 19.99 });
      expect(res.status).toBe(200);
      expect(productsRepository.updateProduct).toHaveBeenCalled();
    });
  });
});
