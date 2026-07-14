import { assertEquals, assertExists } from "@std/assert";
import { parseCartAddArgs } from "../nhp_cli.js";

Deno.test("single part number defaults to qty 1", () => {
  const { items, error } = parseCartAddArgs(["K144"]);
  assertEquals(error, undefined);
  assertEquals(items, [{ partNumber: "K144", qty: 1 }]);
});

Deno.test("part number followed by a small qty is a quantity", () => {
  const { items } = parseCartAddArgs(["K144", "3"]);
  assertEquals(items, [{ partNumber: "K144", qty: 3 }]);
});

Deno.test("a numeric part number with a leading zero is not mistaken for a qty", () => {
  const { items } = parseCartAddArgs(["K144", "06850863"]);
  assertEquals(items, [
    { partNumber: "K144", qty: 1 },
    { partNumber: "06850863", qty: 1 },
  ]);
});

Deno.test("a 5+ digit number is treated as a part number, not a qty", () => {
  const { items } = parseCartAddArgs(["K144", "12345"]);
  assertEquals(items, [
    { partNumber: "K144", qty: 1 },
    { partNumber: "12345", qty: 1 },
  ]);
});

Deno.test("explicit part:qty pairs parse with any positive qty", () => {
  const { items } = parseCartAddArgs(["K144:2", "06850863:10", "KT5AA24V:12000"]);
  assertEquals(items, [
    { partNumber: "K144", qty: 2 },
    { partNumber: "06850863", qty: 10 },
    { partNumber: "KT5AA24V", qty: 12000 },
  ]);
});

Deno.test("invalid quantities are rejected", () => {
  assertExists(parseCartAddArgs(["K144:abc"]).error);
  assertExists(parseCartAddArgs(["K144:0"]).error);
  assertExists(parseCartAddArgs(["K144:"]).error);
  assertExists(parseCartAddArgs([":5"]).error);
});

Deno.test("mixed bare and part:qty forms work together", () => {
  const { items } = parseCartAddArgs(["K144", "KEYL722:4"]);
  assertEquals(items, [
    { partNumber: "K144", qty: 1 },
    { partNumber: "KEYL722", qty: 4 },
  ]);
});
