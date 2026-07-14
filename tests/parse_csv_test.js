import { assertEquals } from "jsr:@std/assert@^1";
import { parseCsvText } from "../config.js";

Deno.test("two-column CSV with header parses part numbers and quantities", () => {
  const items = parseCsvText("Part Number,Quantity\r\nK144,2\r\n06850863,10\r\n");
  assertEquals(items, [
    { itemId: "K144", qty: 2 },
    { itemId: "06850863", qty: 10 },
  ]);
});

Deno.test("single-column CSV defaults qty to 1 and skips the header", () => {
  const items = parseCsvText("Part Number\nK144\nKEYL722\n");
  assertEquals(items, [
    { itemId: "K144", qty: 1 },
    { itemId: "KEYL722", qty: 1 },
  ]);
});

Deno.test("quotes, BOM, and blank lines are tolerated", () => {
  const items = parseCsvText('﻿"K144","2"\n\n"KT5AA24V",1\n');
  assertEquals(items, [
    { itemId: "K144", qty: 2 },
    { itemId: "KT5AA24V", qty: 1 },
  ]);
});

Deno.test("rows with invalid or non-positive quantities are skipped", () => {
  const items = parseCsvText("K144,abc\nKEYL722,0\nKT5AA24V,-2\n100KT3S,5\n");
  assertEquals(items, [{ itemId: "100KT3S", qty: 5 }]);
});
