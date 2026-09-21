import { blue, bold, cyan, dim, green, magenta, red, stripAnsiCode, yellow } from "jsr:@std/fmt@^1/colors";

// Every printed date is dd/mm/yyyy (NZ locale). The API gives ISO timestamps;
// unpadded d/M/yyyy is still accepted (it appears inside line-status strings
// like "Est. Delivery: 22/09/2026"). Anything that isn't a date passes
// through unchanged, so this is safe to run over any header value.
export function formatDate(value) {
  if (!value) return '';
  const s = String(value);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[1].padStart(2, '0')}/${dmy[2].padStart(2, '0')}/${dmy[3]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;
}

// Money: the API gives bare numbers. "$1,234.56"; null for anything else, so
// callers can fall back to N/A rather than printing $NaN.
function fmtMoney(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(n)) return null;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Order statuses are enums (ORDER_RECEIVED, IN_PROGRESS, ON_HOLD, COMPLETED,
// CANCELLED); print them as words. Other strings pass through.
export function humanStatus(value) {
  const s = String(value ?? '');
  if (!/^[A-Z0-9_]+$/.test(s)) return s;
  return s.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

export function printProducts(products, logger) {
  if (!products || products.length === 0) {
    logger.log(yellow(`No products found.`));
    return;
  }
  logger.log(`\n${bold(cyan("=================== SEARCH RESULTS ==================="))}`);
  for (const prod of products) {
    logger.log(` ${bold(blue("•"))} ${bold("Part:")}  ${cyan(prod.sku)}`);
    logger.log(`   ${bold("Name:")}  ${prod.name || prod.custom_display_name || 'N/A'}`);
    logger.log(`   ${bold("Brand:")} ${prod.brand || 'N/A'}`);
    logger.log(`   ${bold("URL:")}   ${dim(prod.product_url || 'N/A')}`);
    logger.log(dim(`------------------------------------------------------`));
  }
}

// ---------------------------------------------------------------------------
// Pricing. Input is getPriceAndStock's per-request entries:
//   { itemId, qty, product, availability, error }
// product.priceBreaks carries the money (price = list, discountedPrice = the
// account's buy price); availability.stockQuantities carries the stock (the
// "national" entry is NZ, the rest are AU warehouses).
// ---------------------------------------------------------------------------

// The quantity-tiered price break that applies to the requested qty: the
// highest tier at or below it, else the lowest tier.
function pickPriceBreak(product, qty) {
  const breaks = (product?.priceBreaks || []).slice().sort((a, b) => (a.quantity || 0) - (b.quantity || 0));
  if (breaks.length === 0) return null;
  let chosen = breaks[0];
  for (const b of breaks) {
    if ((b.quantity || 0) <= qty) chosen = b;
  }
  return chosen;
}

function priceView(entry) {
  const { product, availability } = entry;
  const brk = pickPriceBreak(product, entry.qty);
  const stocks = availability?.stockQuantities || [];
  const nz = stocks.find((s) => s.type === "national");
  const auQty = stocks.filter((s) => s.type !== "national").reduce((sum, s) => sum + (s.quantity || 0), 0);
  return {
    desc: product?.displayName || product?.name || null,
    buy: brk ? (brk.discountedPrice ?? brk.salePrice ?? brk.price) : null,
    list: brk ? brk.price : null,
    nzQty: nz ? nz.quantity || 0 : 0,
    auQty,
  };
}

export function printPricing(results, config = {}, logger) {
  if (!results || results.length === 0) {
    logger.log(yellow(`No pricing results returned.`));
    return;
  }
  logger.log(`\n${bold(cyan("=================== PRICING & STOCK ==================="))}`);
  for (const entry of results) {
    if (entry.error) {
      logger.log(` ${bold(blue("•"))} ${bold("Item:")} ${cyan(entry.itemId)} ${dim(`(Req Qty: ${entry.qty})`)}${red(bold(" [ NOT FOUND ]"))}`);
      logger.log(`   ${red(entry.error)}`);
      logger.log(dim(`-------------------------------------------------------`));
      continue;
    }

    const view = priceView(entry);
    const stockBadge = view.nzQty > 0 ? green(bold(" [ IN STOCK ]")) : red(bold(" [ OUT OF STOCK ]"));

    logger.log(` ${bold(blue("•"))} ${bold("Item:")} ${cyan(entry.itemId)} ${dim(`(Req Qty: ${entry.qty})`)}${stockBadge}`);
    logger.log(`   ${bold("Desc:")} ${view.desc || 'N/A'}`);

    const buyStr = fmtMoney(view.buy);
    logger.log(`   ${bold("Buy:")}  ${green(buyStr || 'N/A')}`);

    if (config.sellMarginMultiplier !== null && config.sellMarginMultiplier !== undefined && view.buy != null) {
      const sell = fmtMoney(view.buy * config.sellMarginMultiplier);
      if (sell) logger.log(`   ${bold("Sell:")} ${yellow(sell)}`);
    }

    const listStr = fmtMoney(view.list);
    if (listStr && view.list !== view.buy) logger.log(`   ${bold("List:")} ${magenta(listStr)}`);

    const nzColor = view.nzQty > 0 ? green : red;
    logger.log(`   ${bold("NZ Stock:")} ${nzColor(bold(String(view.nzQty)))}`);
    logger.log(`   ${bold("AU Stock:")} ${dim(String(view.auQty))}`);
    logger.log(dim(`-------------------------------------------------------`));
  }
}

function getStatusColor(statusStr) {
  const s = (statusStr || '').toLowerCase();
  if (s.includes('invoiced') || s.includes('complete') || s.includes('delivered') || (s.includes('shipped') && !s.includes('partially') && !s.includes('not'))) return green;
  if (s.includes('partially shipped') || s.includes('processing') || s.includes('progress') || s.includes('hold') || s.includes('back order') || s.includes('backorder') || s.includes('est. delivery')) return yellow;
  if (s.includes('not shipped') || s.includes('cancel')) return red;
  return cyan;
}

// The price ledger (the default view for price/csv): one line per part - the
// description truncated to its column so nothing wraps, then the requested
// quantity, buy price, sell price when a margin is configured, and the NZ
// stock as glyph + on-hand quantity + state. An unknown part keeps its line,
// with the portal's reason in the description column and NOT FOUND under
// STOCK, so the rows still line up with what was asked for.
export function printPriceLedger(results, config = {}, logger) {
  if (!results || results.length === 0) {
    logger.log(yellow(`No pricing results returned.`));
    return;
  }
  const hasMargin = config.sellMarginMultiplier !== null && config.sellMarginMultiplier !== undefined;
  const header = [padText("PART", 26), padText("DESCRIPTION", BRIEF_DESC_WIDTH), padText("QTY", 5), padText("BUY", 14)];
  if (hasMargin) header.push(padText("SELL", 12));
  header.push("STOCK");
  logger.log(dim(header.join(" ")));

  for (const entry of results) {
    const qty = padText(String(entry.qty), 5);
    const code = padText(cyan(truncateText(entry.itemId || 'Unknown', 26)), 26);

    if (entry.error) {
      const cells = [code, padText(red(truncateText(entry.error, BRIEF_DESC_WIDTH)), BRIEF_DESC_WIDTH), qty, padText('', 14)];
      if (hasMargin) cells.push(padText('', 12));
      cells.push(red(`${statusGlyph(red)} NOT FOUND`));
      logger.log(cells.join(" "));
      continue;
    }

    const view = priceView(entry);
    const desc = padText(truncateText(view.desc || 'N/A', BRIEF_DESC_WIDTH), BRIEF_DESC_WIDTH);
    const buyStr = fmtMoney(view.buy);
    const cells = [code, desc, qty, padText(buyStr ? green(buyStr) : dim('N/A'), 14)];
    if (hasMargin) {
      const sell = view.buy != null ? fmtMoney(view.buy * config.sellMarginMultiplier) : null;
      cells.push(padText(sell ? yellow(sell) : dim('N/A'), 12));
    }
    const stockColor = view.nzQty > 0 ? green : red;
    cells.push(stockColor(`${statusGlyph(stockColor)} ${view.nzQty} ${view.nzQty > 0 ? 'IN STOCK' : 'OUT OF STOCK'}`));
    logger.log(cells.join(" "));
  }
}

// Ledger-style state glyph matching the status color.
function statusGlyph(color) {
  if (color === green) return "●";
  if (color === yellow) return "◐";
  if (color === red) return "✗";
  return "○";
}

export function printOrders(orders, logger, brief = false) {
  if (!orders || orders.length === 0) {
    logger.log(yellow(`No orders found.`));
    return;
  }
  if (!brief) logger.log(`\n${bold(cyan("======================= ORDERS ======================="))}`);
  else logger.log(dim(`${padText("ORDER", 15)} ${padText("PO", 25)} ${padText("STATUS", 24)} DATE`));
  for (const order of orders) {
    const status = humanStatus(order.status || '');
    const statusColor = getStatusColor(status);

    if (brief) {
      const orderId = padText(cyan(order.orderNo || ''), 15);
      const poStr = padText(yellow(order.poNumber || 'N/A'), 25);
      const statusStr = padText(statusColor(`${statusGlyph(statusColor)} ${status}`), 24);
      logger.log(`${orderId} ${poStr} ${statusStr} ${dim(formatDate(order.orderDate) || 'Unknown')}`);
    } else {
      logger.log(` ${bold(blue("•"))} ${bold("Order ID:")} ${cyan(order.orderNo)}`);
      logger.log(`   ${bold("PO:")}       ${yellow(order.poNumber || 'N/A')}`);
      logger.log(`   ${bold("Date:")}     ${formatDate(order.orderDate) || 'Unknown'}`);
      logger.log(`   ${bold("Total:")}    ${green(fmtMoney(order.total) || 'N/A')}`);
      logger.log(`   ${bold("Status:")}   ${statusColor(status)}`);
      logger.log(dim(`------------------------------------------------------`));
    }
  }
}

export function printInvoices(invoices, logger, brief = false) {
  if (!invoices || invoices.length === 0) {
    logger.log(yellow(`No invoices found.`));
    return;
  }
  // The backend's invoice status is an opaque code the portal itself never
  // displays, so it is not shown here either; the ledger column carries the
  // related order number instead, which links an invoice back to its order.
  if (!brief) logger.log(`\n${bold(cyan("======================= INVOICES ======================="))}`);
  else logger.log(dim(`${padText("INVOICE", 15)} ${padText("ORDER", 15)} ${padText("PO", 25)} DATE`));
  for (const inv of invoices) {
    if (brief) {
      const invId = padText(cyan(inv.invoiceId || ''), 15);
      const orderStr = padText(cyan(inv.salesId || 'N/A'), 15);
      const poStr = padText(yellow(inv.customerRequisition || 'N/A'), 25);
      logger.log(`${invId} ${orderStr} ${poStr} ${dim(formatDate(inv.invoiceDate) || 'Unknown')}`);
    } else {
      logger.log(` ${bold(blue("•"))} ${bold("Invoice No:")} ${cyan(inv.invoiceId)}`);
      logger.log(`   ${bold("PO Number:")}  ${inv.customerRequisition || 'N/A'} ${dim(`(${inv.customerReference || 'No Ref'})`)}`);
      logger.log(`   ${bold("Order:")}      ${inv.salesId || 'N/A'}`);
      logger.log(`   ${bold("Date:")}       ${formatDate(inv.invoiceDate) || 'Unknown'}`);
      logger.log(`   ${bold("Total:")}      ${green(fmtMoney(inv.total) || 'N/A')}`);
      const outstanding = fmtMoney(inv.outstanding);
      if (outstanding && outstanding !== '$0.00') {
        logger.log(`   ${bold("Outst:")}      ${red(outstanding)}`);
      }
      logger.log(dim(`------------------------------------------------------`));
    }
  }
}

function padText(text, width) {
  const stripped = stripAnsiCode(text);
  const padding = Math.max(0, width - stripped.length);
  return text + ' '.repeat(padding);
}

function printHeaderGrid(entries, cols = 2, keyWidth = 25, valWidth = 25, logger) {
  let row = [];
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    const paddedKey = padText(bold(k + ":"), keyWidth);
    const paddedVal = padText(formatDate(v), valWidth);
    row.push(paddedKey + paddedVal);
    if (row.length === cols || i === entries.length - 1) {
      logger.log('   ' + row.join(''));
      row = [];
    }
  }
}

function printAddressesGrid(addresses, width = 35, logger) {
  const colKeys = Object.keys(addresses);
  if (colKeys.length === 0) return;

  const headerRow = colKeys.map(k => padText(bold(blue(k + ":")), width));
  logger.log('   ' + headerRow.join(''));

  const columnsData = colKeys.map(k => addresses[k] ? addresses[k].split('\n').map(l => l.trim()) : []);
  const maxLines = Math.max(...columnsData.map(c => c.length));

  for (let i = 0; i < maxLines; i++) {
    const row = columnsData.map(col => padText(dim(col[i] || ""), width));
    logger.log('   ' + row.join(''));
  }
}

// ---------------------------------------------------------------------------
// Order/invoice details. The API returns structured records; these views
// flatten them to what the printers and exports share:
//   { id, po, ref, date, status, header, addresses, totals, items }
// with items as { code, desc, unitPrice, qty, remainingQty?, total, uom?,
// status?, shipping }. Order lines carry shipping state (remainingQty, ETA);
// invoice lines don't.
// ---------------------------------------------------------------------------

// Line statuses arrive with literal HTML embedded ("Delivered<br/>", or a
// <br/> between status and ETA); strip the tags and collapse the whitespace.
export function cleanStatus(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// GET /orders/{id}: header fields flattened on the object + lineItems.
// netPrice is the account's unit price (unitPrice is list).
export function orderDetailView(data) {
  const items = (data?.lineItems || []).map((l) => ({
    code: l.itemId || '',
    desc: l.itemName || '',
    unitPrice: l.netPrice ?? l.unitPrice,
    qty: l.qty,
    remainingQty: l.remainingQty,
    total: l.lineAmount,
    uom: l.unitOfMeasureDescription || l.unitOfMeasureId || '',
    status: cleanStatus(l.eta || l.lineStatus || (l.isBackOrder ? 'Back Order' : '')),
    shipping: true,
  }));
  const header = {
    "Order No": data?.salesId,
    "Status": humanStatus(data?.status),
    "PO Number": data?.pONumber,
    "Reference": data?.customerReference || data?.customerRequisition,
    "Order Date": data?.orderDate,
    "Requested Ship": data?.requestedShipDate,
    "Delivery Mode": data?.modeOfDeliveryName,
    "Contact": data?.contactName,
  };
  const addresses = {};
  if (data?.deliveryAddress) addresses["Delivery Address"] = [data.deliveryName, data.deliveryAddress].filter(Boolean).join('\n');
  return {
    id: data?.salesId,
    po: data?.pONumber || '',
    ref: data?.customerReference || data?.customerRequisition || '',
    date: data?.orderDate,
    status: humanStatus(data?.status),
    header,
    addresses,
    totals: { subTotal: data?.subTotal, taxTotal: data?.taxTotal, total: data?.total },
    items,
  };
}

// GET /invoices/{id}/line-items: { header, lineItems }.
export function invoiceDetailView(data) {
  const h = data?.header || {};
  const items = (data?.lineItems || []).map((l) => ({
    code: l.itemId || '',
    desc: l.itemName || '',
    unitPrice: l.netPrice ?? l.unitPrice,
    qty: l.quantity,
    total: l.lineAmount,
    status: cleanStatus(l.lineStatus),
    shipping: false,
  }));
  const header = {
    "Invoice No": h.invoiceId,
    "Order No": h.salesId,
    "PO Number": h.customerRequisition,
    "Reference": h.customerReference,
    "Invoice Date": h.invoiceDate,
    "Contact": h.contactName,
  };
  const addresses = {};
  if (h.deliveryAddress) addresses["Delivery Address"] = [h.deliveryName, h.deliveryAddress].filter(Boolean).join('\n');
  return {
    id: h.invoiceId,
    po: h.customerRequisition || '',
    ref: h.customerReference || '',
    date: h.invoiceDate,
    status: humanStatus(h.status),
    header,
    addresses,
    totals: { subTotal: h.subTotal, taxTotal: h.taxTotal, total: h.total },
    items,
  };
}

function printDetailRecord(view, kind, id, logger) {
  const headerEntries = Object.entries(view.header || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');

  if ((!view.items || view.items.length === 0) && headerEntries.length === 0) {
    logger.log(yellow(`No details found for ${kind.toLowerCase()} ${id}. The ${kind.toLowerCase()} may not exist.`));
    return;
  }

  if (headerEntries.length > 0) {
    logger.log(`\n${bold(cyan(`================== ${kind.toUpperCase()} HEADER ==================`))}`);
    printHeaderGrid(headerEntries, 2, 26, 25, logger);
  }

  if (Object.keys(view.addresses || {}).length > 0) {
    logger.log(`\n${bold(cyan(`================= ${kind.toUpperCase()} ADDRESSES =================`))}`);
    printAddressesGrid(view.addresses, 35, logger);
  }

  if (view.items && view.items.length > 0) {
    logger.log(`\n${bold(cyan(`=================== ${kind.toUpperCase()} ITEMS ===================`))}`);
    for (const item of view.items) {
      logger.log(` ${bold(blue("•"))} ${padText(bold("Item:"), 12)} ${cyan(item.code)}`);
      logger.log(`   ${padText(bold("Desc:"), 12)} ${item.desc}`);
      logger.log(`   ${padText(bold("Price:"), 12)} ${green(fmtMoney(item.unitPrice) || 'N/A')}`);

      if (item.shipping) {
        const qtyVal = item.qty ?? 0;
        const remVal = item.remainingQty ?? 0;
        const qtyColor = qtyVal > 0 ? cyan : (s) => s;
        let remColor = (s) => s;
        if (remVal === 0) remColor = green;
        else if (remVal > 0 && remVal < qtyVal) remColor = yellow;
        else if (remVal === qtyVal) remColor = red;
        logger.log(`   ${padText(bold("Ordered:"), 12)} ${qtyColor(bold(String(qtyVal)))} ${item.uom}`);
        logger.log(`   ${padText(bold("Remaining:"), 12)} ${remColor(bold(String(remVal)))} ${item.uom}`);
      } else {
        const qtyColor = (item.qty ?? 0) > 0 ? cyan : dim;
        logger.log(`   ${padText(bold("Qty:"), 12)} ${qtyColor(bold(String(item.qty ?? 0)))}`);
      }
      logger.log(`   ${padText(bold("Total:"), 12)} ${green(fmtMoney(item.total) || 'N/A')}`);

      if (item.status) {
        const statusColor = getStatusColor(item.status);
        logger.log(`   ${padText(bold("Status:"), 12)} ${statusColor(item.status)}`);
      }
      logger.log(dim(`---------------------------------------------------`));
    }

    logger.log(`\n${bold(cyan(`${kind.toUpperCase()} TOTAL`))}`);
    const t = view.totals || {};
    if (t.subTotal != null) logger.log(`   ${padText(bold("Subtotal:"), 12)} ${green(fmtMoney(t.subTotal))}`);
    if (t.taxTotal != null) logger.log(`   ${padText(bold("Tax:"), 12)} ${green(fmtMoney(t.taxTotal))}`);
    logger.log(`   ${padText(bold("Total:"), 12)} ${green(bold(fmtMoney(t.total) || 'N/A'))}`);
    logger.log(dim(`===================================================`));
  } else {
    logger.log(yellow(`No items found for ${kind.toLowerCase()} ${id}.`));
  }
}

export function printOrderDetails(data, orderId, logger) {
  printDetailRecord(orderDetailView(data), "Order", orderId, logger);
}

export function printInvoiceDetails(data, invoiceId, logger) {
  printDetailRecord(invoiceDetailView(data), "Invoice", invoiceId, logger);
}

// The brief item ledger. Takes a detail view (orderDetailView /
// invoiceDetailView output).
export function printBriefItems(view, logger, id, idLabel = "Order") {
  const items = view?.items || [];
  if (items.length === 0) return;

  // The id leads the summary line so stacked ledgers (nhp order A B C) stay
  // identifiable. It comes from the argument rather than the response, whose
  // id fields differ between orders and invoices.
  const summary = [];
  if (id) summary.push(`${dim(idLabel + ":")} ${cyan(String(id))}`);
  summary.push(`${dim("PO:")} ${yellow(view.po || "N/A")}`, `${dim("Ref:")} ${yellow(view.ref || "N/A")}`, `${dim("Date:")} ${yellow(formatDate(view.date) || "Unknown")}`);
  logger.log(` ${summary.join(dim(" | "))}`);

  // Order items carry shipping columns (remainingQty/status); invoice items
  // don't, so the invoice ledger collapses to PART DESCRIPTION QTY.
  const shipping = items.some((i) => i.shipping);
  const cols = shipping
    ? `${padText("PART", 26)} ${padText("DESCRIPTION", BRIEF_DESC_WIDTH)} ${padText("DLV/ORD", 9)} STATUS`
    : `${padText("PART", 26)} ${padText("DESCRIPTION", BRIEF_DESC_WIDTH)} QTY`;
  logger.log(dim(cols));

  for (const item of items) {
    const code = padText(cyan(truncateText(item.code || 'Unknown', 26)), 26);
    const desc = padText(truncateText(item.desc || '', BRIEF_DESC_WIDTH), BRIEF_DESC_WIDTH);
    const ordered = parseInt(item.qty, 10);
    const orderedStr = isNaN(ordered) ? String(item.qty || 0) : String(ordered);

    if (!shipping) {
      logger.log(`${code} ${desc} ${green(bold(orderedStr))}`);
      continue;
    }

    const remaining = parseInt(item.remainingQty, 10);
    const delivered = isNaN(remaining) || isNaN(ordered) ? null : Math.max(0, ordered - remaining);
    const qtyColor = deliveryColor(ordered, delivered);
    const qtyStr = padText(qtyColor(bold(`${delivered === null ? '?' : delivered}/${orderedStr}`)), 9);
    const status = item.status || '';
    const statusColor = getStatusColor(status);
    logger.log(`${code} ${desc} ${qtyStr} ${statusColor(`${statusGlyph(statusColor)} ${status}`)}`);
  }
}

// Description column width in the brief item ledger; longer text is cut
// with an ellipsis so every item stays on one line.
const BRIEF_DESC_WIDTH = 40;

function truncateText(text, width) {
  const s = String(text ?? '');
  return s.length > width ? s.slice(0, width - 1) + '…' : s;
}

// Same traffic-light scheme as the Remaining line in the record view:
// green fully delivered, yellow partial, red nothing delivered yet.
function deliveryColor(ordered, delivered) {
  if (delivered === null || !(ordered > 0)) return (s) => s;
  if (delivered >= ordered) return green;
  if (delivered > 0) return yellow;
  return red;
}

export function printCart(cartData, logger) {
  const lines = cartData?.lineItems || [];
  if (lines.length === 0) {
    logger.log(yellow(`Cart is empty.`));
    return;
  }

  logger.log(`\n${bold(cyan("====================== SHOPPING CART ======================"))} `);
  let index = 1;
  for (const item of lines) {
    logger.log(` ${bold(blue(index++ + "."))} ${padText(bold("Part:"), 10)} ${cyan(item.productID)}`);
    logger.log(`    ${padText(bold("Desc:"), 10)} ${item.displayName || item.name || 'N/A'}`);
    logger.log(`    ${padText(bold("Qty:"), 10)} ${green(bold(String(item.quantity)))} ${dim(`(@ ${fmtMoney(item.unitPrice) || 'N/A'} ea)`)}`);
    logger.log(`    ${padText(bold("Total:"), 10)} ${green(fmtMoney(item.lineTotal) || 'N/A')}`);
    logger.log(dim(`-----------------------------------------------------------`));
  }

  const cart = cartData?.cart || {};
  logger.log(`\n${bold(cyan("CART TOTALS"))}`);
  logger.log(`    ${padText(bold("Subtotal:"), 12)} ${green(fmtMoney(cart.subtotal) || "$0.00")}`);
  logger.log(`    ${padText(bold("Tax:"), 12)} ${green(fmtMoney(cart.taxCost) || "$0.00")}`);
  logger.log(`    ${padText(bold("Total:"), 12)} ${green(bold(fmtMoney(cart.total) || "$0.00"))}`);
  logger.log(dim(`===========================================================`));
}

// ---------------------------------------------------------------------------
// --tsv: the spreadsheet export.
// One header row, then one tab-separated row per record, so a paste lands
// straight in columns. Parent fields (order/invoice number, PO, ...) repeat on
// every line-item row - a flat table, no merged headers. Plain text only: no
// colour, glyphs, or truncation; money and quantities are bare numbers so the
// sheet treats them as numeric; tabs and newlines inside a field are squashed
// to a space so a row can never split. A cell is blank where the backend has
// no such value.
// ---------------------------------------------------------------------------
export const ORDER_ITEM_TSV_COLUMNS = ["ORDER", "PO", "ORDER STATUS", "DATE", "LINE", "PART", "DESCRIPTION", "DELIVERED", "ORDERED", "LINE STATUS", "UNIT PRICE", "TOTAL"];
export const ORDER_LIST_TSV_COLUMNS = ["ORDER", "PO", "STATUS", "DATE", "TOTAL"];
export const INVOICE_ITEM_TSV_COLUMNS = ["INVOICE", "PO", "REF", "DATE", "LINE", "PART", "DESCRIPTION", "QTY", "UNIT PRICE", "TOTAL"];
export const INVOICE_LIST_TSV_COLUMNS = ["INVOICE", "PO", "REF", "STATUS", "DATE", "TOTAL", "OUTSTANDING"];
export const PRICE_TSV_COLUMNS = ["PART", "DESCRIPTION", "QTY", "BUY", "SELL", "LIST", "CURRENCY", "STOCK", "STOCK STATUS", "ERROR"];

function tsvCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

// Money as a bare number for the sheet; "" when there is no value.
function tsvMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]+/g, ''));
  return isNaN(n) ? '' : Math.round(n * 100) / 100;
}

function tsvInt(value) {
  const n = parseInt(value, 10);
  return isNaN(n) ? '' : n;
}

export function printTsv(columns, rows, logger) {
  logger.tsv(columns.join('\t'));
  for (const row of rows) logger.tsv(row.map(tsvCell).join('\t'));
}

// `order --tsv`: one row per line item, LINE from the backend's own lineNo.
export function orderItemTsvRows(data, orderId) {
  const view = orderDetailView(data);
  return (data?.lineItems || []).map((l, i) => {
    const ordered = tsvInt(l.qty);
    const remaining = tsvInt(l.remainingQty);
    const delivered = ordered === '' || remaining === '' ? '' : Math.max(0, ordered - remaining);
    const status = cleanStatus(l.eta || l.lineStatus || (l.isBackOrder ? 'Back Order' : ''));
    return [orderId || view.id || '', view.po, view.status, formatDate(view.date), l.lineNo ?? i + 1, l.itemId || '', l.itemName || '', delivered, ordered, status, tsvMoney(l.netPrice ?? l.unitPrice), tsvMoney(l.lineAmount)];
  });
}

// `orders --tsv` (and the multi-hit outcome of `po`).
export function orderListTsvRows(orders) {
  return (orders || []).map((o) => [o.orderNo || '', o.poNumber || '', humanStatus(o.status || ''), formatDate(o.orderDate), tsvMoney(o.total)]);
}

// `invoice --tsv`: one row per invoice line.
export function invoiceItemTsvRows(data, invoiceId) {
  const view = invoiceDetailView(data);
  return (data?.lineItems || []).map((l, i) => [invoiceId || view.id || '', view.po, view.ref, formatDate(view.date), l.lineNo ?? i + 1, l.itemId || '', l.itemName || '', tsvInt(l.quantity), tsvMoney(l.netPrice ?? l.unitPrice), tsvMoney(l.lineAmount)]);
}

// `invoices --tsv`. STATUS stays blank: the backend's invoice status is an
// opaque code the portal never displays (the column itself is shared across
// the supplier tools, so it keeps its place).
export function invoiceListTsvRows(invoices) {
  return (invoices || []).map((inv) => [inv.invoiceId || '', inv.customerRequisition || '', inv.customerReference || '', '', formatDate(inv.invoiceDate), tsvMoney(inv.total), tsvMoney(inv.outstanding)]);
}

// `price --tsv` / `csv --tsv`: one row per requested part. An unknown part
// keeps PART and QTY and puts the backend's reason in ERROR. STOCK is the NZ
// on-hand quantity; LIST comes from the price break's undiscounted price.
export function priceTsvRows(results, config = {}) {
  return (results || []).map((entry) => {
    if (entry.error) {
      return [entry.itemId || '', '', entry.qty, '', '', '', '', '', '', entry.error];
    }
    const view = priceView(entry);
    const buy = tsvMoney(view.buy);
    const margin = config.sellMarginMultiplier;
    const sell = margin !== null && margin !== undefined && buy !== '' ? tsvMoney(buy * margin) : '';
    return [entry.itemId || '', view.desc || '', entry.qty, buy, sell, tsvMoney(view.list), 'NZD', view.nzQty, view.nzQty > 0 ? 'IN STOCK' : 'OUT OF STOCK', ''];
  });
}
