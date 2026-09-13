import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { stripAnsiCode } from "jsr:@std/fmt@^1/colors";
import { formatDate, INVOICE_ITEM_TSV_COLUMNS, INVOICE_LIST_TSV_COLUMNS, invoiceItemTsvRows, invoiceListTsvRows, ORDER_ITEM_TSV_COLUMNS, ORDER_LIST_TSV_COLUMNS, orderItemTsvRows, orderListTsvRows, PRICE_TSV_COLUMNS, priceTsvRows, printBriefItems, printOrderDetails, printPricing, printTsv } from "../formatters.js";
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
  tsv(line) {
    this.lines.push(line);
  }
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

Deno.test("order --tsv: one header row then one tab-separated row per item, money and quantities bare", () => {
  const logger = new TestLogger();
  const longDesc = "MODULAR Key Lock Type 144 with an unreasonably long marketing description attached";
  const data = {
    header: { "Purchase order number": "1234/J001", "Order Created on": "2026-07-01", "Status": "Partially Shipped" },
    addresses: {},
    items: [
      { ProductCode: "K144", Description: longDesc, UnitPrice: "$1,010.00", Quantity: "5", RemainingQuantity: "2", UOM: "EA", Status: "Partially Shipped", Total: "$5,050.00" },
      { ProductCode: "06850863", Description: "Tabs\tand\nnewlines", UnitPrice: "$1.00", Quantity: "3", RemainingQuantity: "3", UOM: "EA", Status: "Not Shipped", Total: "$3.00" },
    ],
  };
  printTsv(ORDER_ITEM_TSV_COLUMNS, orderItemTsvRows(data, "54321"), logger);

  const [hdr, row1, row2] = logger.lines;
  assertEquals(logger.lines.length, 3);
  assertEquals(hdr, ORDER_ITEM_TSV_COLUMNS.join("\t"));
  for (const line of logger.lines) assertEquals(line.split("\t").length, ORDER_ITEM_TSV_COLUMNS.length, `cell count: ${line}`);
  assertEquals(row1.split("\t"), ["54321", "1234/J001", "Partially Shipped", "01/07/2026", "1", "K144", longDesc, "3", "5", "Partially Shipped", "1010", "5050"]);
  assertEquals(row2.split("\t"), ["54321", "1234/J001", "Partially Shipped", "01/07/2026", "2", "06850863", "Tabs and newlines", "0", "3", "Not Shipped", "1", "3"]);
  assert(!/[●◐✗○…$]/.test(logger.output), "no glyphs, ellipses, or currency symbols in the export");
});

Deno.test("orders --tsv and invoices --tsv: one row per record from the list fields", () => {
  const orders = new TestLogger();
  printTsv(ORDER_LIST_TSV_COLUMNS, orderListTsvRows([{ OrderId: "54321", PurchaseNumber: "1234/J001", OrderStatus: "Invoiced", OrderDate: "2026-07-01", TotalText: "$5,053.00" }]), orders);
  assertEquals(orders.lines, ["ORDER\tPO\tSTATUS\tDATE\tTOTAL", "54321\t1234/J001\tInvoiced\t01/07/2026\t5053"]);

  const invoices = new TestLogger();
  printTsv(INVOICE_LIST_TSV_COLUMNS, invoiceListTsvRows([{ DocumentNumber: "INV1", PurchaseNumber: "1234/J001", CustomerReference: "Example Site", Status: "Paid", InvoiceDate: "2026-07-03", TotalText: "$5,053.00", OutstandingText: "$0.00" }]), invoices);
  assertEquals(invoices.lines, ["INVOICE\tPO\tREF\tSTATUS\tDATE\tTOTAL\tOUTSTANDING", "INV1\t1234/J001\tExample Site\tPaid\t03/07/2026\t5053\t0"]);
});

Deno.test("invoice --tsv: one row per invoice line with QTY, no shipping columns", () => {
  const logger = new TestLogger();
  const data = {
    header: { "Purchase order number": "1234/J001", "Customer Reference": "Example Site", "Invoice Date": "2026-07-03" },
    items: [{ ProductCode: "K144", Description: "Key", UnitPrice: "$10.00", Quantity: "5", Total: "$50.00" }],
  };
  printTsv(INVOICE_ITEM_TSV_COLUMNS, invoiceItemTsvRows(data, "INV1"), logger);
  assertEquals(logger.lines, ["INVOICE\tPO\tREF\tDATE\tLINE\tPART\tDESCRIPTION\tQTY\tUNIT PRICE\tTOTAL", "INV1\t1234/J001\tExample Site\t03/07/2026\t1\tK144\tKey\t5\t10\t50"]);
});

Deno.test("price --tsv: bare numbers, sell from the margin, NZ stock, and an ERROR row for unknown parts", () => {
  const logger = new TestLogger();
  const requests = [{ itemId: "PGT8710", qty: 2 }, { itemId: "P160F23100TM", qty: 1 }];
  printTsv(PRICE_TSV_COLUMNS, priceTsvRows(fixture.ChildProducts, requests, { sellMarginMultiplier: 1.25 }), logger);

  assertEquals(logger.lines.length, 3);
  assertEquals(logger.lines[0], "PART\tDESCRIPTION\tQTY\tBUY\tSELL\tLIST\tCURRENCY\tSTOCK\tSTOCK STATUS\tERROR");
  const [, unknown, known] = logger.lines;
  const u = unknown.split("\t");
  assertEquals(u[0], "PGT8710");
  assertEquals(u[2], "2");
  assertStringIncludes(u[9], "Item not recognised");
  assertEquals(known.split("\t"), ["P160F23100TM", "Terasaki TemBreak PRO MCCB 160 Frame 36kA 3P 100A Adj. Therm. Adj. Mag.", "1", "100", "125", "", "NZD", "6", "IN STOCK", ""]);

  const plain = new TestLogger();
  printTsv(PRICE_TSV_COLUMNS, priceTsvRows([fixture.ChildProducts[1]], requests, {}), plain);
  assertEquals(plain.lines[1].split("\t")[4], "", "no margin configured -> SELL blank");
});

// Regression: the live invoice page labels its header "Invoice date" (lower-case
// d) and "Customer Reference no"; the order page uses "Order Created on" and
// the same "Customer Reference no". Both the ledger summary and the exports
// must pick those up rather than printing Unknown / blank.
Deno.test("scraped header labels: 'Invoice date' and 'Customer Reference no' are recognised", () => {
  const data = {
    header: { "Document no": "SIN1", "Invoice date": "4/09/2026", "Purchase order number": "1234/J001", "Customer Reference no": "Example Site" },
    items: [{ ProductCode: "DOORLATCH", Description: "DOOR LATCH STANDARD", UnitPrice: "$6.00", Quantity: "30", Total: "$180.00" }],
  };
  const tsv = new TestLogger();
  printTsv(INVOICE_ITEM_TSV_COLUMNS, invoiceItemTsvRows(data, "SIN1"), tsv);
  assertEquals(tsv.lines[1].split("\t").slice(0, 4), ["SIN1", "1234/J001", "Example Site", "04/09/2026"]);

  const ledger = new TestLogger();
  printBriefItems(data, ledger, "SIN1", "Invoice");
  assertStringIncludes(ledger.lines[0], "Ref: Example Site");
  assertStringIncludes(ledger.lines[0], "Date: 04/09/2026");
});

Deno.test("formatDate renders every date as dd/mm/yyyy and passes non-dates through", () => {
  assertEquals(formatDate("3/09/2026"), "03/09/2026");
  assertEquals(formatDate("28/08/2026"), "28/08/2026");
  assertEquals(formatDate("2026-07-01T00:00:00Z"), "01/07/2026");
  assertEquals(formatDate(""), "");
  assertEquals(formatDate(undefined), "");
  assertEquals(formatDate("Not a date"), "Not a date");
});

Deno.test("printOrderDetails header grid normalises scraped dates", () => {
  const logger = new TestLogger();
  printOrderDetails({ header: { "Order No": "SOR1", "Order Created on": "3/09/2026", "Status": "Invoiced" }, addresses: {}, items: [] }, "SOR1", logger);
  assertStringIncludes(logger.output, "03/09/2026");
  assert(!logger.output.includes(" 3/09/2026"), "unpadded portal date must not leak through");
});
