import { assert, assertStringIncludes } from "jsr:@std/assert@^1";
import { stripAnsiCode } from "jsr:@std/fmt@^1/colors";
import { printOrderDetails, printPricing } from "../formatters.js";
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

Deno.test("printPricing marks unknown parts as NOT FOUND with the API message", () => {
  const logger = new TestLogger();
  const requests = [{ itemId: "PGT8710", qty: 1 }, { itemId: "P160F23100TM", qty: 1 }];
  printPricing(fixture.ChildProducts, requests, { sellMarginMultiplier: 1.25 }, logger);

  assertStringIncludes(logger.output, "[ NOT FOUND ]");
  assertStringIncludes(logger.output, "Item not recognised");
  assert(!logger.output.includes("null"), "should not print 'null'");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
  assert(!logger.output.includes("$NaN"), "should not print '$NaN'");
});

Deno.test("printPricing renders valid products with buy and sell prices", () => {
  const logger = new TestLogger();
  const requests = [{ itemId: "P160F23100TM", qty: 1 }];
  printPricing([fixture.ChildProducts[1]], requests, { sellMarginMultiplier: 1.25 }, logger);

  assertStringIncludes(logger.output, "P160F23100TM");
  assertStringIncludes(logger.output, "$363.66");
  assertStringIncludes(logger.output, "$454.58");
  assertStringIncludes(logger.output, "[ IN STOCK ]");
});

Deno.test("printPricing falls back to N/A instead of $undefined for priceless products", () => {
  const logger = new TestLogger();
  const prod = {
    ProductId: "MYSTERY1",
    DisplayName: null,
    Description: null,
    OnHandQty: 3,
    DCOnHandQty: 0,
    AdjustedPriceWithCurrency: null,
    HasError: false,
    ProductExist: true,
  };
  printPricing([prod], [{ itemId: "MYSTERY1", qty: 1 }], { sellMarginMultiplier: 1.25 }, logger);

  assertStringIncludes(logger.output, "N/A");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
  assert(!logger.output.includes("$NaN"), "should not print '$NaN'");
});

Deno.test("printOrderDetails reports a likely nonexistent order instead of hollow sections", () => {
  const logger = new TestLogger();
  const data = {
    header: { "Order Created on": "" },
    addresses: { "Sell-To Address": "", "Bill-To Address": "" },
    items: [],
  };
  printOrderDetails(data, "FAKE99999", logger);

  assertStringIncludes(logger.output, "may not exist");
  assert(!logger.output.includes("ORDER HEADER"), "should not print an empty header section");
  assert(!logger.output.includes("ORDER ADDRESSES"), "should not print an empty addresses section");
});

Deno.test("printOrderDetails renders items and totals", () => {
  const logger = new TestLogger();
  const data = {
    header: { "Order number": "1234567" },
    addresses: {},
    items: [
      {
        ProductCode: "K144",
        Description: "MODULAR Key Lock Type 144",
        UnitPrice: "$10.00",
        Quantity: "2",
        RemainingQuantity: "0",
        UOM: "EA",
        Status: "Shipped",
        Total: "$20.00",
      },
    ],
  };
  printOrderDetails(data, "1234567", logger);

  assertStringIncludes(logger.output, "K144");
  assertStringIncludes(logger.output, "ORDER HEADER");
  assertStringIncludes(logger.output, "$20.00");
});
