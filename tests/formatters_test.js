import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { stripAnsiCode } from "jsr:@std/fmt@^1/colors";
import { printBriefItems, printOrderDetails, printPricing } from "../formatters.js";
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
  assertStringIncludes(logger.output, "$100.00");
  assertStringIncludes(logger.output, "$125.00");
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

Deno.test("printBriefItems (order) is one ledger line per item: part, truncated desc, dlv/ord, glyph+status", () => {
  const logger = new TestLogger();
  const longDesc = "MODULAR Key Lock Type 144 with an unreasonably long marketing description attached";
  const data = {
    header: { "Purchase order number": "1234/J001", "Order Created on": "2026-07-01" },
    addresses: {},
    items: [
      { ProductCode: "K144", Description: longDesc, UnitPrice: "$10.00", Quantity: "5", RemainingQuantity: "2", UOM: "EA", Status: "Partially Shipped", Total: "$50.00" },
      { ProductCode: "06850863", Description: "Short", UnitPrice: "$1.00", Quantity: "3", RemainingQuantity: "3", UOM: "EA", Status: "Not Shipped", Total: "$3.00" },
    ],
  };
  printBriefItems(data, logger);

  const [hdr, cols, row1, row2] = logger.lines;
  assertEquals(logger.lines.length, 4, "header line + column line + one line per item, nothing else");
  assertStringIncludes(hdr, "1234/J001");
  assertStringIncludes(cols, "PART");
  assertStringIncludes(cols, "DESCRIPTION");
  assertStringIncludes(cols, "DLV/ORD");
  assertStringIncludes(cols, "STATUS");

  assertStringIncludes(row1, "K144");
  assertStringIncludes(row1, "…", "long description is truncated with an ellipsis");
  assert(!row1.includes(longDesc), "full description must not leak onto the line");
  assertStringIncludes(row1, "3/5", "delivered = ordered - remaining");
  assertStringIncludes(row1, "◐ Partially Shipped");

  assertStringIncludes(row2, "0/3");
  assertStringIncludes(row2, "✗ Not Shipped");
  assert(row2.indexOf("Short") < row2.indexOf("0/3"), "DESCRIPTION column comes before DLV/ORD");
});

Deno.test("printBriefItems (invoice) drops the shipping columns", () => {
  const logger = new TestLogger();
  const data = {
    header: { "Invoice Date": "2026-07-02" },
    addresses: {},
    items: [{ ProductCode: "K144", Description: "MODULAR Key Lock", UnitPrice: "$10.00", Quantity: "2", Total: "$20.00" }],
  };
  printBriefItems(data, logger);

  const [, cols, row] = logger.lines;
  assertEquals(logger.lines.length, 3);
  assertStringIncludes(cols, "QTY");
  assert(!cols.includes("DLV/ORD"), "no delivered column without shipping data");
  assert(!cols.includes("STATUS"), "no status column without shipping data");
  assertStringIncludes(row, "MODULAR Key Lock");
  assert(/\b2$/.test(row.trimEnd()), "quantity is the last column");
});

Deno.test("printBriefItems leads the summary line with the id it was given", () => {
  const logger = new TestLogger();
  const data = {
    header: { "Purchase order number": "1234/J001", "Order Created on": "2026-07-01" },
    addresses: {},
    items: [{ ProductCode: "K144", Description: "MODULAR Key Lock", UnitPrice: "$10.00", Quantity: "1", RemainingQuantity: "0", UOM: "EA", Status: "Fully Shipped", Total: "$10.00" }],
  };
  printBriefItems(data, logger, "1234567");

  const [hdr] = logger.lines;
  assertStringIncludes(hdr, "Order: 1234567");
  assertStringIncludes(hdr, "1234/J001");
});

Deno.test("printBriefItems labels an invoice id and prints it without a scraped header", () => {
  const logger = new TestLogger();
  const data = { header: {}, addresses: {}, items: [{ ProductCode: "K144", Description: "MODULAR Key Lock", Quantity: "2" }] };
  printBriefItems(data, logger, "0087654321", "Invoice");

  assertStringIncludes(logger.lines[0], "Invoice: 0087654321");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
});
