import { blue, bold, cyan, dim, green, magenta, red, stripAnsiCode, yellow } from "jsr:@std/fmt@^1/colors";

// Every printed date is dd/mm/yyyy (NZ locale). The
// portal gives d/M/yyyy without zero padding ("3/09/2026", day first - the
// 28/08/2026 entries prove the order); ISO is accepted too. Anything that
// isn't a date passes through unchanged, so this is safe to run over every
// scraped header value.
export function formatDate(value) {
  if (!value) return '';
  const s = String(value);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[1].padStart(2, '0')}/${dmy[2].padStart(2, '0')}/${dmy[3]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;
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

export function printPricing(results, originalRequests = [], config = {}, logger) {
  if (!results || results.length === 0) {
    logger.log(yellow(`No pricing results returned.`));
    return;
  }
  logger.log(`\n${bold(cyan("=================== PRICING & STOCK ==================="))}`);
  for (const prod of results) {
    const orig = originalRequests.find(p => p.itemId.toLowerCase() === prod.ProductId.toLowerCase());
    const requestedQty = orig ? orig.qty : 1;
    
    if (prod.HasError || prod.ProductExist === false) {
      logger.log(` ${bold(blue("•"))} ${bold("Item:")} ${cyan(prod.ProductId)} ${dim(`(Req Qty: ${requestedQty})`)}${red(bold(" [ NOT FOUND ]"))}`);
      const reason = prod.ErrorMessages?.length ? prod.ErrorMessages.join("; ") : "Item not recognised.";
      logger.log(`   ${red(reason)}`);
      logger.log(dim(`-------------------------------------------------------`));
      continue;
    }

    const nzStock = parseInt(prod.OnHandQty, 10) || 0;
    const stockBadge = nzStock > 0 ? green(bold(" [ IN STOCK ]")) : red(bold(" [ OUT OF STOCK ]"));

    logger.log(` ${bold(blue("•"))} ${bold("Item:")} ${cyan(prod.ProductId)} ${dim(`(Req Qty: ${requestedQty})`)}${stockBadge}`);
    logger.log(`   ${bold("Desc:")} ${prod.Description || prod.DisplayName || 'N/A'}`);

    const buyPrice = prod.AdjustedPriceWithCurrency || (prod.NetPrice != null ? `$${prod.NetPrice}` : 'N/A');
    logger.log(`   ${bold("Buy:")}  ${green(buyPrice)}`);

    if (config.sellMarginMultiplier !== null && config.sellMarginMultiplier !== undefined) {
      const sellPriceNum = parseFloat(buyPrice.replace(/[^0-9.]/g, '')) * config.sellMarginMultiplier;
      if (!isNaN(sellPriceNum)) {
        logger.log(`   ${bold("Sell:")} ${yellow(`$${sellPriceNum.toFixed(2)}`)}`);
      }
    }

    if (prod.Discount) logger.log(`   ${bold("Disc:")} ${magenta(prod.Discount)}`);
    
    const nzColor = nzStock > 0 ? green : red;
    logger.log(`   ${bold("NZ Stock:")} ${nzColor(bold(String(prod.OnHandQty)))} ${dim(`(${prod.StockStatusName || prod.StockStatus?.Name || 'Unknown'})`)}`);
    logger.log(`   ${bold("AU Stock:")} ${dim(String(prod.DCOnHandQty))}`);
    logger.log(dim(`-------------------------------------------------------`));
  }
}

function getStatusColor(statusStr) {
  const s = (statusStr || '').toLowerCase();
  if (s.includes('invoiced') || s.includes('complete') || (s.includes('shipped') && !s.includes('partially') && !s.includes('not'))) return green;
  if (s.includes('partially shipped') || s.includes('processing')) return yellow;
  if (s.includes('not shipped') || s.includes('cancel')) return red;
  return cyan;
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
    const status = order.OrderStatus || order.Status || '';
    const statusColor = getStatusColor(status);

    if (brief) {
      const orderId = padText(cyan(order.OrderId || order.OrderID || ''), 15);
      const poStr = padText(yellow(order.PurchaseNumber || 'N/A'), 25);
      const statusStr = padText(statusColor(`${statusGlyph(statusColor)} ${status}`), 24);
      logger.log(`${orderId} ${poStr} ${statusStr} ${dim(formatDate(order.OrderDate) || 'Unknown')}`);
    } else {
      logger.log(` ${bold(blue("•"))} ${bold("Order ID:")} ${cyan(order.OrderId || order.OrderID)}`);
      logger.log(`   ${bold("PO:")}       ${yellow(order.PurchaseNumber || 'N/A')}`);
      logger.log(`   ${bold("Date:")}     ${formatDate(order.OrderDate) || 'Unknown'}`);
      logger.log(`   ${bold("Total:")}    ${green(order.TotalText || order.Total || '$0.00')}`);
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
  if (!brief) logger.log(`\n${bold(cyan("======================= INVOICES ======================="))}`);
  else logger.log(dim(`${padText("INVOICE", 15)} ${padText("PO", 25)} ${padText("STATUS", 24)} DATE`));
  for (const inv of invoices) {
    const status = inv.OrderStatus || inv.Status || '';
    const statusColor = getStatusColor(status);

    if (brief) {
      const invId = padText(cyan(inv.DocumentNumber || ''), 15);
      const poStr = padText(yellow(inv.PurchaseNumber || 'N/A'), 25);
      const statusStr = padText(statusColor(`${statusGlyph(statusColor)} ${status}`), 24);
      logger.log(`${invId} ${poStr} ${statusStr} ${dim(formatDate(inv.InvoiceDate) || 'Unknown')}`);
    } else {
      logger.log(` ${bold(blue("•"))} ${bold("Invoice No:")} ${cyan(inv.DocumentNumber)}`);
      logger.log(`   ${bold("PO Number:")}  ${inv.PurchaseNumber || 'N/A'} ${dim(`(${inv.CustomerReference || 'No Ref'})`)}`);
      logger.log(`   ${bold("Date:")}       ${formatDate(inv.InvoiceDate) || 'Unknown'}`);
      logger.log(`   ${bold("Total:")}      ${green(inv.TotalText || '$0.00')}`);
      
      if (inv.OutstandingText && inv.OutstandingText !== '$0.00') {
          logger.log(`   ${bold("Outst:")}      ${red(inv.OutstandingText)}`);
      }
      logger.log(`   ${bold("Status:")}     ${statusColor(status)}`);
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

export function printOrderDetails(data, orderId, logger) {
  const { header, addresses, items } = data || {};

  const headerEntries = Object.entries(header || {}).filter(([, v]) => v);
  const filledAddresses = {};
  for (const [k, v] of Object.entries(addresses || {})) {
    if (v) filledAddresses[k] = v;
  }

  if ((!items || items.length === 0) && headerEntries.length === 0 && Object.keys(filledAddresses).length === 0) {
    logger.log(yellow(`No details found for order ${orderId}. The order may not exist.`));
    return;
  }

  if (headerEntries.length > 0) {
    logger.log(`\n${bold(cyan("================== ORDER HEADER =================="))}`);
    printHeaderGrid(headerEntries, 2, 26, 25, logger);
  }

  if (Object.keys(filledAddresses).length > 0) {
    logger.log(`\n${bold(cyan("================= ORDER ADDRESSES ================="))}`);
    printAddressesGrid(filledAddresses, 35, logger);
  }

  if (items && items.length > 0) {
    logger.log(`\n${bold(cyan("=================== ORDER ITEMS ==================="))}`);
    let grandTotal = 0;
    for (const item of items) {
      logger.log(` ${bold(blue("•"))} ${padText(bold("Item:"), 12)} ${cyan(item.ProductCode)}`);
      logger.log(`   ${padText(bold("Desc:"), 12)} ${item.Description}`);
      logger.log(`   ${padText(bold("Price:"), 12)} ${green(item.UnitPrice)}`);
      
      const qtyVal = parseInt(item.Quantity, 10);
      const remVal = parseInt(item.RemainingQuantity, 10);
      
      const qtyColor = qtyVal > 0 ? cyan : (s) => s;
      let remColor = (s) => s;
      if (remVal === 0) remColor = green;
      else if (remVal > 0 && remVal < qtyVal) remColor = yellow;
      else if (remVal === qtyVal) remColor = red;

      logger.log(`   ${padText(bold("Ordered:"), 12)} ${qtyColor(bold(item.Quantity))} ${item.UOM}`);
      logger.log(`   ${padText(bold("Remaining:"), 12)} ${remColor(bold(item.RemainingQuantity))} ${item.UOM}`);
      logger.log(`   ${padText(bold("Total:"), 12)} ${green(item.Total)}`);
      
      const statusColor = getStatusColor(item.Status);
      logger.log(`   ${padText(bold("Status:"), 12)} ${statusColor(item.Status)}`);
      logger.log(dim(`---------------------------------------------------`));

      const totalStr = item.Total || "0";
      const num = parseFloat(totalStr.replace(/[^0-9.-]+/g, ''));
      if (!isNaN(num)) grandTotal += num;
    }
    
    logger.log(`\n${bold(cyan("ORDER TOTAL"))}`);
    logger.log(`   ${padText(bold("Total Cost:"), 12)} ${green(bold('$' + grandTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})))}`);
    logger.log(dim(`===================================================`));
  } else {
    logger.log(yellow(`No items found for order ${orderId}.`));
  }
}

export function printInvoiceDetails(data, invoiceId, logger) {
  const { header, addresses, items } = data || {};

  const headerEntries = Object.entries(header || {}).filter(([, v]) => v);
  const filledAddresses = {};
  for (const [k, v] of Object.entries(addresses || {})) {
    if (v) filledAddresses[k] = v;
  }

  if ((!items || items.length === 0) && headerEntries.length === 0 && Object.keys(filledAddresses).length === 0) {
    logger.log(yellow(`No details found for invoice ${invoiceId}. The invoice may not exist.`));
    return;
  }

  if (headerEntries.length > 0) {
    logger.log(`\n${bold(cyan("================= INVOICE HEADER ================="))}`);
    printHeaderGrid(headerEntries, 2, 26, 25, logger);
  }

  if (Object.keys(filledAddresses).length > 0) {
    logger.log(`\n${bold(cyan("================ INVOICE ADDRESSES ================"))}`);
    printAddressesGrid(filledAddresses, 35, logger);
  }

  if (items && items.length > 0) {
    logger.log(`\n${bold(cyan("================== INVOICE ITEMS =================="))}`);
    let grandTotal = 0;
    for (const item of items) {
      logger.log(` ${bold(blue("•"))} ${padText(bold("Item:"), 12)} ${cyan(item.ProductCode)}`);
      logger.log(`   ${padText(bold("Desc:"), 12)} ${item.Description}`);
      logger.log(`   ${padText(bold("Price:"), 12)} ${green(item.UnitPrice)}`);
      
      const qtyVal = parseInt(item.Quantity, 10);
      const qtyColor = qtyVal > 0 ? cyan : dim;
      logger.log(`   ${padText(bold("Qty:"), 12)} ${qtyColor(bold(item.Quantity))}`);
      logger.log(`   ${padText(bold("Total:"), 12)} ${green(item.Total)}`);
      
      logger.log(dim(`---------------------------------------------------`));

      const totalStr = item.Total || "0";
      const num = parseFloat(totalStr.replace(/[^0-9.-]+/g, ''));
      if (!isNaN(num)) grandTotal += num;
    }
    
    logger.log(`\n${bold(cyan("================= INVOICE TOTAL ==================="))}`);
    logger.log(`   ${padText(bold("Total Cost:"), 12)} ${green(bold('$' + grandTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})))}`);
    logger.log(dim(`===================================================`));
  } else {
    logger.log(yellow(`No items found for invoice: ${invoiceId}`));
  }
}

export function printBriefItems(data, logger, id, idLabel = "Order") {
  const { header, items } = data || {};
  if (!items || items.length === 0) return;

  // The id leads the summary line so stacked ledgers (nhp order A B C) stay
  // identifiable. It comes from the argument rather than the scraped header,
  // whose labels differ between orders and invoices.
  const summary = [];
  if (id) summary.push(`${dim(idLabel + ":")} ${cyan(String(id))}`);
  if (header && Object.keys(header).length > 0) {
    const po = headerField(header, HEADER_PO_KEYS) || "N/A";
    const ref = headerField(header, HEADER_REF_KEYS) || "N/A";
    const date = formatDate(headerField(header, HEADER_DATE_KEYS)) || "Unknown";
    summary.push(`${dim("PO:")} ${yellow(po)}`, `${dim("Ref:")} ${yellow(ref)}`, `${dim("Date:")} ${yellow(date)}`);
  }
  if (summary.length > 0) logger.log(` ${summary.join(dim(" | "))}`);

  // Order items carry shipping columns (RemainingQuantity/Status); invoice
  // items don't, so the invoice ledger collapses to PART DESCRIPTION QTY.
  const shipping = items.some(i => i.RemainingQuantity !== undefined || i.Status !== undefined);
  const cols = shipping
    ? `${padText("PART", 26)} ${padText("DESCRIPTION", BRIEF_DESC_WIDTH)} ${padText("DLV/ORD", 9)} STATUS`
    : `${padText("PART", 26)} ${padText("DESCRIPTION", BRIEF_DESC_WIDTH)} QTY`;
  logger.log(dim(cols));

  for (const item of items) {
    const code = padText(cyan(truncateText(item.ProductCode || 'Unknown', 26)), 26);
    const desc = padText(truncateText(item.Description || '', BRIEF_DESC_WIDTH), BRIEF_DESC_WIDTH);
    const ordered = parseInt(item.Quantity, 10);
    const orderedStr = isNaN(ordered) ? String(item.Quantity || 0) : String(ordered);

    if (!shipping) {
      logger.log(`${code} ${desc} ${green(bold(orderedStr))}`);
      continue;
    }

    const remaining = parseInt(item.RemainingQuantity, 10);
    const delivered = isNaN(remaining) || isNaN(ordered) ? null : Math.max(0, ordered - remaining);
    const qtyColor = deliveryColor(ordered, delivered);
    const qtyStr = padText(qtyColor(bold(`${delivered === null ? '?' : delivered}/${orderedStr}`)), 9);
    const status = item.Status || '';
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

// Same traffic-light scheme as the Remaining line in printOrderDetails:
// green fully delivered, yellow partial, red nothing delivered yet.
function deliveryColor(ordered, delivered) {
  if (delivered === null || !(ordered > 0)) return (s) => s;
  if (delivered >= ordered) return green;
  if (delivered > 0) return yellow;
  return red;
}

export function printCart(cartData, logger) {
  if (!cartData || !cartData.Lines || cartData.Lines.length === 0) {
    logger.log(yellow(`Cart is empty.`));
    return;
  }
  
  logger.log(`\n${bold(cyan("====================== SHOPPING CART ======================"))} `);
  let index = 1;
  for (const item of cartData.Lines) {
    logger.log(` ${bold(blue(index++ + "."))} ${padText(bold("Part:"), 10)} ${cyan(item.SKUID)}`);
    logger.log(`    ${padText(bold("Desc:"), 10)} ${item.DisplayName}`);
    logger.log(`    ${padText(bold("Qty:"), 10)} ${green(bold(item.Quantity))} ${dim(`(@ ${item.LinePrice} ea)`)}`);
    logger.log(`    ${padText(bold("Total:"), 10)} ${green(item.LineTotal)}`);
    logger.log(dim(`-----------------------------------------------------------`));
  }
  
  logger.log(`\n${bold(cyan("CART TOTALS"))}`);
  logger.log(`    ${padText(bold("Subtotal:"), 12)} ${green(cartData.Subtotal || "$0.00")}`);
  logger.log(`    ${padText(bold("Tax:"), 12)} ${green(cartData.TaxTotal || "$0.00")}`);
  logger.log(`    ${padText(bold("Total:"), 12)} ${green(bold(cartData.Total || "$0.00"))}`);
  logger.log(dim(`===========================================================`));
}

// ---------------------------------------------------------------------------
// --tsv: the spreadsheet export.
// One header row, then one tab-separated row per record, so a paste lands
// straight in columns. Parent fields (order/invoice number, PO, ...) repeat on
// every line-item row - a flat table, no merged headers. Plain text only: no
// colour, glyphs, or truncation; money and quantities are bare numbers so the
// sheet treats them as numeric; tabs and newlines inside a field are squashed
// to a space so a row can never split. A cell is blank where the portal has
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

// Money as a bare number for the sheet. The portal is scraped, so this takes
// the display strings it gives ("$1,234.56") as well as numbers; "" when
// there is no value.
function tsvMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]+/g, ''));
  return isNaN(n) ? '' : Math.round(n * 100) / 100;
}

function tsvInt(value) {
  const n = parseInt(value, 10);
  return isNaN(n) ? '' : n;
}

// The scraped order/invoice header is a label -> value map whose labels vary
// between pages and are not capitalised consistently: the order page says
// "Order Created on" and "Customer Reference no", the invoice page
// "Invoice date" (lower-case d) and the same "Customer Reference no". The
// first present key wins; the lists are shared by the ledger summary line and
// the --tsv exports so both agree on what they pull out.
const HEADER_PO_KEYS = ["Purchase order number", "Purchase Number", "PO Number", "PO"];
const HEADER_REF_KEYS = ["Customer Reference no", "Customer Reference", "Reference", "Job Reference"];
const HEADER_DATE_KEYS = ["Order Created on", "Order Date", "Invoice date", "Invoice Date", "Date"];
const HEADER_STATUS_KEYS = ["Status", "Order Status"];

function headerField(header, keys) {
  for (const k of keys) if (header?.[k]) return header[k];
  return '';
}

export function printTsv(columns, rows, logger) {
  logger.tsv(columns.join('\t'));
  for (const row of rows) logger.tsv(row.map(tsvCell).join('\t'));
}

// `order --tsv`: one row per line item. NHP lines carry no line number, so
// LINE is the 1-based position on the page.
export function orderItemTsvRows(data, orderId) {
  const { header, items } = data || {};
  const po = headerField(header, HEADER_PO_KEYS);
  const status = headerField(header, HEADER_STATUS_KEYS);
  const date = formatDate(headerField(header, HEADER_DATE_KEYS));
  return (items || []).map((item, i) => {
    const ordered = tsvInt(item.Quantity);
    const remaining = tsvInt(item.RemainingQuantity);
    const delivered = ordered === '' || remaining === '' ? '' : Math.max(0, ordered - remaining);
    return [orderId || '', po, status, date, i + 1, item.ProductCode || '', item.Description || '', delivered, ordered, item.Status || '', tsvMoney(item.UnitPrice), tsvMoney(item.Total)];
  });
}

// `orders --tsv` (and the multi-hit outcome of `po`).
export function orderListTsvRows(orders) {
  return (orders || []).map((o) => [o.OrderId || o.OrderID || '', o.PurchaseNumber || '', o.OrderStatus || o.Status || '', formatDate(o.OrderDate), tsvMoney(o.TotalText || o.Total)]);
}

// `invoice --tsv`: one row per invoice line.
export function invoiceItemTsvRows(data, invoiceId) {
  const { header, items } = data || {};
  const po = headerField(header, HEADER_PO_KEYS);
  const ref = headerField(header, HEADER_REF_KEYS);
  const date = formatDate(headerField(header, HEADER_DATE_KEYS));
  return (items || []).map((item, i) => [invoiceId || '', po, ref, date, i + 1, item.ProductCode || '', item.Description || '', tsvInt(item.Quantity), tsvMoney(item.UnitPrice), tsvMoney(item.Total)]);
}

// `invoices --tsv`.
export function invoiceListTsvRows(invoices) {
  return (invoices || []).map((inv) => [inv.DocumentNumber || '', inv.PurchaseNumber || '', inv.CustomerReference || '', inv.OrderStatus || inv.Status || '', formatDate(inv.InvoiceDate), tsvMoney(inv.TotalText), tsvMoney(inv.OutstandingText)]);
}

// `price --tsv` / `csv --tsv`: one row per returned part. An unknown part keeps
// PART and QTY and puts the reason in ERROR. STOCK is the NZ on-hand quantity
// and STOCK STATUS the same in/out test as the badge; the portal has no list
// price, so LIST is blank and the currency is always NZD.
export function priceTsvRows(results, originalRequests = [], config = {}) {
  return (results || []).map((prod) => {
    const orig = originalRequests.find((p) => p.itemId.toLowerCase() === (prod.ProductId || '').toLowerCase());
    const qty = orig ? orig.qty : 1;
    if (prod.HasError || prod.ProductExist === false) {
      const reason = prod.ErrorMessages?.length ? prod.ErrorMessages.join("; ") : "Item not recognised.";
      return [prod.ProductId || '', '', qty, '', '', '', '', '', '', reason];
    }
    const buy = tsvMoney(prod.AdjustedPriceWithCurrency ?? prod.NetPrice);
    const margin = config.sellMarginMultiplier;
    const sell = margin !== null && margin !== undefined && buy !== '' ? tsvMoney(buy * margin) : '';
    const nzStock = tsvInt(prod.OnHandQty);
    return [prod.ProductId || '', prod.Description || prod.DisplayName || '', qty, buy, sell, '', 'NZD', nzStock, nzStock > 0 ? 'IN STOCK' : 'OUT OF STOCK', ''];
  });
}
