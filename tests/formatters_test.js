import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { stripAnsiCode } from "jsr:@std/fmt@^1/colors";
import { formatDate, humanStatus, INVOICE_ITEM_TSV_COLUMNS, INVOICE_LIST_TSV_COLUMNS, invoiceDetailView, invoiceItemTsvRows, invoiceListTsvRows, ORDER_ITEM_TSV_COLUMNS, ORDER_LIST_TSV_COLUMNS, orderDetailView, orderItemTsvRows, orderListTsvRows, PRICE_TSV_COLUMNS, priceTsvRows, printBriefItems, printInvoices, printOrderDetails, printPricing, printTsv } from "../formatters.js";
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

// An order detail response as GET /api/v1/commerce/orders/{id} returns it:
// header fields flattened on the object, lineItems alongside. Figures are
// synthetic.
function orderFixture() {
  return {
    salesId: "SOR9900001",
    status: "ORDER_RECEIVED",
    pONumber: "1234/J001",
    customerReference: "",
    customerRequisition: "1234/J001",
    orderDate: "2026-07-01T00:00:00.000Z",
    deliveryName: "Example Co",
    deliveryAddress: "1 Example St\nSuburb\nCity 1010\nNew Zealand",
    contactName: "A Person",
    subTotal: 53,
    taxTotal: 7.95,
    total: 60.95,
    lineItems: [
      {
        itemId: "K144",
        itemName: "MODULAR Key Lock Type 144 with an unreasonably long marketing description attached",
        lineNo: 1,
        qty: 5,
        remainingQty: 2,
        unitPrice: 20,
        netPrice: 10,
        lineAmount: 50,
        unitOfMeasureDescription: "EACH",
        eta: "Est. Delivery: 22/09/2026",
        isBackOrder: true,
      },
      {
        itemId: "06850863",
        itemName: "Tabs\tand\nnewlines",
        lineNo: 2,
        qty: 3,
        remainingQty: 3,
        unitPrice: 2,
        netPrice: 1,
        lineAmount: 3,
        unitOfMeasureDescription: "EACH",
        eta: "Not Shipped",
        isBackOrder: false,
      },
    ],
  };
}

// An invoice detail response as GET .../invoices/{id}/line-items returns it.
function invoiceFixture() {
  return {
    header: {
      invoiceId: "SIN9900001",
      salesId: "SOR9900001",
      status: "3",
      customerReference: "Example Site",
      customerRequisition: "1234/J001",
      invoiceDate: "2026-07-03T00:00:00+00:00",
      deliveryName: "Example Co",
      deliveryAddress: "1 Example St\nSuburb\nCity 1010\nNew Zealand",
      contactName: "A Person",
      subTotal: 50,
      taxTotal: 7.5,
      total: 57.5,
    },
    lineItems: [
      { itemId: "K144", itemName: "Key", lineNo: 1, quantity: 5, unitPrice: 20, netPrice: 10, lineAmount: 50, lineStatus: "" },
    ],
  };
}

Deno.test("printPricing marks unknown parts as NOT FOUND with the API message", () => {
  const logger = new TestLogger();
  printPricing(fixture.products, { sellMarginMultiplier: 1.25 }, logger);

  assertStringIncludes(logger.output, "[ NOT FOUND ]");
  assertStringIncludes(logger.output, "product not found");
  assert(!logger.output.includes("null"), "should not print 'null'");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
  assert(!logger.output.includes("$NaN"), "should not print '$NaN'");
});

Deno.test("printPricing renders valid products with buy, sell, and list prices", () => {
  const logger = new TestLogger();
  printPricing([fixture.products[1]], { sellMarginMultiplier: 1.25 }, logger);

  assertStringIncludes(logger.output, "P160F23100TM");
  assertStringIncludes(logger.output, "$100.00");
  assertStringIncludes(logger.output, "$125.00");
  assertStringIncludes(logger.output, "$300.00", "list price from the price break");
  assertStringIncludes(logger.output, "[ IN STOCK ]");
  assertStringIncludes(logger.output, "NZ Stock: 6");
  assertStringIncludes(logger.output, "AU Stock: 8");
});

Deno.test("printPricing falls back to N/A instead of $undefined for priceless products", () => {
  const logger = new TestLogger();
  const entry = {
    itemId: "MYSTERY1",
    qty: 1,
    product: { id: "MYSTERY1", name: null, displayName: null, priceBreaks: [] },
    availability: { productId: "MYSTERY1", stockQuantities: [{ quantity: 3, location: "New Zealand", type: "national" }] },
    error: null,
  };
  printPricing([entry], { sellMarginMultiplier: 1.25 }, logger);

  assertStringIncludes(logger.output, "N/A");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
  assert(!logger.output.includes("$NaN"), "should not print '$NaN'");
});

Deno.test("printOrderDetails reports a likely nonexistent order instead of hollow sections", () => {
  const logger = new TestLogger();
  printOrderDetails({}, "FAKE99999", logger);

  assertStringIncludes(logger.output, "may not exist");
  assert(!logger.output.includes("ORDER HEADER"), "should not print an empty header section");
  assert(!logger.output.includes("ORDER ADDRESSES"), "should not print an empty addresses section");
});

Deno.test("printOrderDetails renders items, addresses, and totals from the API record", () => {
  const logger = new TestLogger();
  printOrderDetails(orderFixture(), "SOR9900001", logger);

  assertStringIncludes(logger.output, "K144");
  assertStringIncludes(logger.output, "ORDER HEADER");
  assertStringIncludes(logger.output, "Order Received", "status enum is humanised");
  assertStringIncludes(logger.output, "$50.00");
  assertStringIncludes(logger.output, "$60.95", "order total comes from the record, not a re-sum");
  assertStringIncludes(logger.output, "1 Example St");
  assert(!logger.output.includes("ORDER_RECEIVED"), "raw enum must not leak through");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
});

Deno.test("printBriefItems (order) is one ledger line per item: part, truncated desc, dlv/ord, glyph+status", () => {
  const logger = new TestLogger();
  const data = orderFixture();
  printBriefItems(orderDetailView(data), logger);

  const [hdr, cols, row1, row2] = logger.lines;
  assertEquals(logger.lines.length, 4, "header line + column line + one line per item, nothing else");
  assertStringIncludes(hdr, "1234/J001");
  assertStringIncludes(cols, "PART");
  assertStringIncludes(cols, "DESCRIPTION");
  assertStringIncludes(cols, "DLV/ORD");
  assertStringIncludes(cols, "STATUS");

  assertStringIncludes(row1, "K144");
  assertStringIncludes(row1, "…", "long description is truncated with an ellipsis");
  assert(!row1.includes(data.lineItems[0].itemName), "full description must not leak onto the line");
  assertStringIncludes(row1, "3/5", "delivered = ordered - remaining");
  assertStringIncludes(row1, "◐ Est. Delivery: 22/09/2026");

  assertStringIncludes(row2, "0/3");
  assertStringIncludes(row2, "✗ Not Shipped");
});

Deno.test("printBriefItems (invoice) drops the shipping columns", () => {
  const logger = new TestLogger();
  printBriefItems(invoiceDetailView(invoiceFixture()), logger);

  const [, cols, row] = logger.lines;
  assertEquals(logger.lines.length, 3);
  assertStringIncludes(cols, "QTY");
  assert(!cols.includes("DLV/ORD"), "no delivered column without shipping data");
  assert(!cols.includes("STATUS"), "no status column without shipping data");
  assertStringIncludes(row, "Key");
  assert(/\b5$/.test(row.trimEnd()), "quantity is the last column");
});

Deno.test("printBriefItems leads the summary line with the id it was given", () => {
  const logger = new TestLogger();
  printBriefItems(orderDetailView(orderFixture()), logger, "SOR9900001");

  const [hdr] = logger.lines;
  assertStringIncludes(hdr, "Order: SOR9900001");
  assertStringIncludes(hdr, "1234/J001");
  assertStringIncludes(hdr, "Date: 01/07/2026");
});

Deno.test("printBriefItems labels an invoice id and never prints undefined", () => {
  const logger = new TestLogger();
  printBriefItems(invoiceDetailView(invoiceFixture()), logger, "SIN9900001", "Invoice");

  assertStringIncludes(logger.lines[0], "Invoice: SIN9900001");
  assertStringIncludes(logger.lines[0], "Ref: Example Site");
  assert(!logger.output.includes("undefined"), "should not print 'undefined'");
});

Deno.test("order --tsv: one header row then one tab-separated row per item, money and quantities bare", () => {
  const logger = new TestLogger();
  const data = orderFixture();
  printTsv(ORDER_ITEM_TSV_COLUMNS, orderItemTsvRows(data, "SOR9900001"), logger);

  const [hdr, row1, row2] = logger.lines;
  assertEquals(logger.lines.length, 3);
  assertEquals(hdr, ORDER_ITEM_TSV_COLUMNS.join("\t"));
  for (const line of logger.lines) assertEquals(line.split("\t").length, ORDER_ITEM_TSV_COLUMNS.length, `cell count: ${line}`);
  assertEquals(row1.split("\t"), ["SOR9900001", "1234/J001", "Order Received", "01/07/2026", "1", "K144", data.lineItems[0].itemName, "3", "5", "Est. Delivery: 22/09/2026", "10", "50"]);
  assertEquals(row2.split("\t"), ["SOR9900001", "1234/J001", "Order Received", "01/07/2026", "2", "06850863", "Tabs and newlines", "0", "3", "Not Shipped", "1", "3"]);
  assert(!/[●◐✗○…$]/.test(logger.output), "no glyphs, ellipses, or currency symbols in the export");
});

Deno.test("orders --tsv and invoices --tsv: one row per record from the list fields", () => {
  const orders = new TestLogger();
  printTsv(ORDER_LIST_TSV_COLUMNS, orderListTsvRows([{ orderNo: "SOR9900001", poNumber: "1234/J001", status: "COMPLETED", orderDate: "2026-07-01T00:00:00.000Z", total: 5053, currency: "NZD" }]), orders);
  assertEquals(orders.lines, ["ORDER\tPO\tSTATUS\tDATE\tTOTAL", "SOR9900001\t1234/J001\tCompleted\t01/07/2026\t5053"]);

  // STATUS is deliberately blank: the backend's invoice status is an opaque
  // code ("3") that the portal itself never displays.
  const invoices = new TestLogger();
  printTsv(INVOICE_LIST_TSV_COLUMNS, invoiceListTsvRows([{ invoiceId: "SIN9900001", salesId: "SOR9900001", customerRequisition: "1234/J001", customerReference: "Example Site", status: "3", invoiceDate: "2026-07-03T00:00:00+00:00", total: 5053, outstanding: null }]), invoices);
  assertEquals(invoices.lines, ["INVOICE\tPO\tREF\tSTATUS\tDATE\tTOTAL\tOUTSTANDING", "SIN9900001\t1234/J001\tExample Site\t\t03/07/2026\t5053\t"]);
});

Deno.test("printInvoices ledger shows the related order instead of the undisplayable status code", () => {
  const logger = new TestLogger();
  printInvoices([{ invoiceId: "SIN9900001", salesId: "SOR9900001", customerRequisition: "1234/J001", customerReference: "", status: "3", invoiceDate: "2026-07-03T00:00:00+00:00", total: 5053, outstanding: null }], logger, true);

  const [cols, row] = logger.lines;
  assertStringIncludes(cols, "ORDER");
  assert(!cols.includes("STATUS"), "no status column in the invoice ledger");
  assertStringIncludes(row, "SIN9900001");
  assertStringIncludes(row, "SOR9900001");
  assertStringIncludes(row, "03/07/2026");
  assert(!/\b3\b/.test(row.replace("03/07/2026", "")), "the status code must not appear anywhere");
});

Deno.test("invoice --tsv: one row per invoice line with QTY, no shipping columns", () => {
  const logger = new TestLogger();
  printTsv(INVOICE_ITEM_TSV_COLUMNS, invoiceItemTsvRows(invoiceFixture(), "SIN9900001"), logger);
  assertEquals(logger.lines, ["INVOICE\tPO\tREF\tDATE\tLINE\tPART\tDESCRIPTION\tQTY\tUNIT PRICE\tTOTAL", "SIN9900001\t1234/J001\tExample Site\t03/07/2026\t1\tK144\tKey\t5\t10\t50"]);
});

Deno.test("price --tsv: bare numbers, sell from the margin, list price, NZ stock, and an ERROR row for unknown parts", () => {
  const logger = new TestLogger();
  printTsv(PRICE_TSV_COLUMNS, priceTsvRows(fixture.products, { sellMarginMultiplier: 1.25 }), logger);

  assertEquals(logger.lines.length, 3);
  assertEquals(logger.lines[0], "PART\tDESCRIPTION\tQTY\tBUY\tSELL\tLIST\tCURRENCY\tSTOCK\tSTOCK STATUS\tERROR");
  const [, unknown, known] = logger.lines;
  const u = unknown.split("\t");
  assertEquals(u[0], "PGT8710");
  assertEquals(u[2], "2");
  assertStringIncludes(u[9], "product not found");
  assertEquals(known.split("\t"), ["P160F23100TM", "Terasaki TemBreak PRO MCCB 160 Frame 36kA 3P 100A Adj. Therm. Adj. Mag.", "1", "100", "125", "300", "NZD", "6", "IN STOCK", ""]);

  const plain = new TestLogger();
  printTsv(PRICE_TSV_COLUMNS, priceTsvRows([fixture.products[1]], {}), plain);
  assertEquals(plain.lines[1].split("\t")[4], "", "no margin configured -> SELL blank");
});

Deno.test("formatDate renders every date as dd/mm/yyyy and passes non-dates through", () => {
  assertEquals(formatDate("3/09/2026"), "03/09/2026");
  assertEquals(formatDate("28/08/2026"), "28/08/2026");
  assertEquals(formatDate("2026-07-01T00:00:00Z"), "01/07/2026");
  assertEquals(formatDate(""), "");
  assertEquals(formatDate(undefined), "");
  assertEquals(formatDate("Not a date"), "Not a date");
});

// Regression: line statuses arrive with literal HTML embedded - a delivered
// line's eta/orderStatus is "Delivered<br/>". No tag may ever be printed.
Deno.test("line statuses with embedded HTML are cleaned before printing", () => {
  const data = orderFixture();
  data.lineItems[0].eta = "Delivered<br/>";
  data.lineItems[1].eta = "Part Shipped<br/>Est. Delivery: 22/09/2026";

  const logger = new TestLogger();
  printBriefItems(orderDetailView(data), logger);
  assertStringIncludes(logger.lines[2], "● Delivered");
  assertStringIncludes(logger.lines[3], "Part Shipped Est. Delivery: 22/09/2026");
  assert(!logger.output.includes("<br"), "no HTML tags in the ledger");

  const tsv = new TestLogger();
  printTsv(ORDER_ITEM_TSV_COLUMNS, orderItemTsvRows(data, "SOR9900001"), tsv);
  assert(!tsv.output.includes("<br"), "no HTML tags in the export");
});

Deno.test("humanStatus turns enums into words and passes everything else through", () => {
  assertEquals(humanStatus("ORDER_RECEIVED"), "Order Received");
  assertEquals(humanStatus("IN_PROGRESS"), "In Progress");
  assertEquals(humanStatus("COMPLETED"), "Completed");
  assertEquals(humanStatus("3"), "3");
  assertEquals(humanStatus("Est. Delivery: 22/09/2026"), "Est. Delivery: 22/09/2026");
  assertEquals(humanStatus(undefined), "");
});

Deno.test("printOrderDetails header grid normalises ISO dates", () => {
  const logger = new TestLogger();
  printOrderDetails(orderFixture(), "SOR9900001", logger);
  assertStringIncludes(logger.output, "01/07/2026");
  assert(!logger.output.includes("2026-07-01T"), "raw ISO timestamp must not leak through");
});
