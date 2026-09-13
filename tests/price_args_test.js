import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { parsePartQtyArgs } from "../nhp_cli.js";

Deno.test("price args: bare parts get the default quantity", () => {
  const { items, error } = parsePartQtyArgs(["K144", "06850863"]);
  assertEquals(error, undefined);
  assertEquals(items, [{ itemId: "K144", qty: 1 }, { itemId: "06850863", qty: 1 }]);
});

Deno.test("price args: --qty sets the default for parts without :qty", () => {
  const { items } = parsePartQtyArgs(["K144", "06850863:10"], 3);
  assertEquals(items, [{ itemId: "K144", qty: 3 }, { itemId: "06850863", qty: 10 }]);
});

Deno.test("price args: part:qty sets an explicit quantity of any size", () => {
  const { items } = parsePartQtyArgs(["K144:2", "06850863:12000"]);
  assertEquals(items, [{ itemId: "K144", qty: 2 }, { itemId: "06850863", qty: 12000 }]);
});

Deno.test("price args: a bare number is a part number, never a quantity", () => {
  // Unlike `cart add`, price has no two-argument heuristic: NHP part numbers
  // can be all digits and a price check routinely lists many of them.
  const { items } = parsePartQtyArgs(["K144", "3"]);
  assertEquals(items, [{ itemId: "K144", qty: 1 }, { itemId: "3", qty: 1 }]);
});

Deno.test("price args: invalid quantities and malformed items are rejected", () => {
  for (const bad of ["K144:0", "K144:-1", "K144:abc", "K144:", "K144:2:3", ":2"]) {
    const { error } = parsePartQtyArgs([bad]);
    assertExists(error, `expected an error for '${bad}'`);
  }
});
