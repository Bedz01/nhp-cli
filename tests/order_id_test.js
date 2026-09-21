import { assertEquals } from "jsr:@std/assert@^1";
import { normalizeOrderId, orderCartItems } from "../api.js";

// Regression: GET /api/v1/commerce/orders/{id} takes the bare sales order
// number. The order list's `id` field is a composite ("NZ-20198-SOR1314816")
// that the endpoint 404s on, so both forms must resolve to the bare number.
Deno.test("order ids: composite list ids and bare sales numbers both resolve to the bare number", () => {
  assertEquals(normalizeOrderId("SOR1314816"), "SOR1314816");
  assertEquals(normalizeOrderId("NZ-20198-SOR1314816"), "SOR1314816");
  assertEquals(normalizeOrderId("sor1314816"), "SOR1314816");
  // A part-number-looking id with no composite prefix passes through untouched.
  assertEquals(normalizeOrderId("06850863"), "06850863");
});

// `cart from-order` re-adds an order's lines: deleted and zero-quantity
// lines (cancelled / "To Be Confirmed") are skipped, repeats are merged.
Deno.test("orderCartItems keeps addable lines only and merges repeated parts", () => {
  const lines = [
    { itemId: "K144", qty: 2, isdeleted: false },
    { itemId: "K144", qty: 3, isdeleted: false },
    { itemId: "DP873", qty: 0, isdeleted: false },
    { itemId: "GT5050", qty: 1, isdeleted: true },
    { itemId: "", qty: 5, isdeleted: false },
  ];
  assertEquals(orderCartItems(lines), [{ itemId: "K144", qty: 5 }]);
  assertEquals(orderCartItems(undefined), []);
});
