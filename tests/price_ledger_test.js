import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { stripAnsiCode } from "jsr:@std/fmt@^1/colors";
import { printPriceLedger } from "../formatters.js";
import fixture from "./fixtures/pricing_response.json" with { type: "json" };

class TestLogger {
  constructor() {
    this.lines = [];
    this.isJson = false;
  }
  log(...args) {
    this.lines.push(stripAnsiCode(args.join(" ")));
  }
  error(...args) {
    this.log(...args);
  }
  warn(...args) {
    this.log(...args);
  }
  debug() {}
  json() {}
  get output() {
    return this.lines.join("\n");
  }
}

const requests = [{ itemId: "PGT8710", qty: 2 }, { itemId: "P160F23100TM", qty: 1 }];

Deno.test("price ledger: header then strictly one line per part, unknown parts keep their line", () => {
  const logger = new TestLogger();
  printPriceLedger(fixture.ChildProducts, requests, { sellMarginMultiplier: 1.25 }, logger);

  assertEquals(logger.lines.length, 3, "header + one line per part");
  const [header, unknown, known] = logger.lines;
  assert(header.startsWith("PART"), "dim uppercase header");
  assertStringIncludes(header, "DESCRIPTION");
  assertStringIncludes(header, "BUY");
  assertStringIncludes(header, "SELL");
  assertStringIncludes(header, "STOCK");
  assert(!logger.output.includes("=====") && !logger.output.includes("•"), "no banner or bullets in the ledger");

  assert(unknown.startsWith("PGT8710"));
  assertStringIncludes(unknown, "Item not recognised");
  assertStringIncludes(unknown, "✗ NOT FOUND");
  assertStringIncludes(unknown, " 2 ", "requested quantity is shown");

  assert(known.startsWith("P160F23100TM"));
  assertStringIncludes(known, "$100.00");
  assertStringIncludes(known, "$125.00");
  assertStringIncludes(known, "● 6 IN STOCK");
});

Deno.test("price ledger: the description is truncated with … so a line never wraps, and columns line up", () => {
  const logger = new TestLogger();
  printPriceLedger(fixture.ChildProducts, requests, {}, logger);
  const known = logger.lines[2];
  const fullDesc = fixture.ChildProducts[1].Description;
  assert(fullDesc.length > 40, "fixture description must be long enough to truncate");
  assert(!known.includes(fullDesc), "full description must not be printed");
  assertStringIncludes(known, "…");
  // PART (26) + space: DESCRIPTION starts at column 27 on every row.
  for (const line of logger.lines) assertEquals(line.slice(26, 27), " ", `column boundary: ${line}`);
  assertEquals(logger.lines[0].indexOf("DESCRIPTION"), 27);
  assertEquals(known.indexOf(fullDesc.slice(0, 10)), 27);
});

Deno.test("price ledger: no SELL column without a margin, N/A instead of $undefined for priceless parts", () => {
  const logger = new TestLogger();
  const prod = { ProductId: "MYSTERY1", Description: null, DisplayName: null, OnHandQty: 0, AdjustedPriceWithCurrency: null, HasError: false, ProductExist: true };
  printPriceLedger([prod], [{ itemId: "MYSTERY1", qty: 1 }], {}, logger);
  assert(!logger.lines[0].includes("SELL"));
  assertStringIncludes(logger.lines[1], "N/A");
  assertStringIncludes(logger.lines[1], "✗ 0 OUT OF STOCK");
  assert(!logger.output.includes("undefined") && !logger.output.includes("$NaN"));
});
