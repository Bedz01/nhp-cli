import { green, yellow, red, cyan, bold, dim, blue, magenta, stripColor } from "https://deno.land/std@0.224.0/fmt/colors.ts";
import { readTextFile, getEnv } from "./fs_adapter.js";

// Set to null to disable sell price calculation, or a number like 1.25 for a 25% margin.
export const SELL_MARGIN_MULTIPLIER = null;

export async function loadCredentials() {
  try {
    const text = await readTextFile("credentials.json");
    const json = JSON.parse(text);
    if (json.username && json.password) {
      return { username: json.username, password: json.password };
    }
  } catch (err) {
    console.warn(`[Warning] Could not read credentials from 'credentials.json': ${err.message}`);
  }

  const usernameEnv = getEnv("NHP_USERNAME");
  const passwordEnv = getEnv("NHP_PASSWORD");
  if (usernameEnv && passwordEnv) {
    return { username: usernameEnv, password: passwordEnv };
  }

  throw new Error("Credentials not found. Please configure 'credentials.json' or set NHP_USERNAME and NHP_PASSWORD env variables.");
}

export function extractToken(html) {
  const crsfContainer = html.match(/id=["']_CRSFform["'][\s\S]*?<input[^>]+value=["']([^"']+)["']/i);
  if (crsfContainer) {
    return crsfContainer[1];
  }

  const globalMatch = html.match(/name=["']__RequestVerificationToken["'][^>]+value=["']([^"']+)["']/i) ||
                      html.match(/value=["']([^"']+)["'][^>]+name=["']__RequestVerificationToken["']/i);
  if (globalMatch) {
    return globalMatch[1];
  }

  throw new Error("Could not find __RequestVerificationToken in HTML");
}

export async function parseCsv(filePath) {
  const text = await readTextFile(filePath);
  const lines = text.split(/\r?\n/);
  const items = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const parts = trimmed.split(",");
    if (parts.length < 2) continue;
    
    const itemId = parts[0].replace(/['"]/g, "").trim();
    const qty = parseInt(parts[1].trim(), 10);
    
    if (itemId && !isNaN(qty)) {
      items.push({ itemId, qty });
    }
  }
  return items;
}

export function printProducts(products, origConsoleLog = console.log) {
  if (!products || products.length === 0) {
    origConsoleLog(yellow(`No products found.`));
    return;
  }
  origConsoleLog(`\n${bold(cyan("=================== SEARCH RESULTS ==================="))}`);
  for (const prod of products) {
    origConsoleLog(` ${bold(blue("•"))} ${bold("SKU:")}   ${cyan(prod.sku)}`);
    origConsoleLog(`   ${bold("Name:")}  ${prod.name || prod.custom_display_name}`);
    origConsoleLog(`   ${bold("Brand:")} ${prod.brand || 'N/A'}`);
    origConsoleLog(`   ${bold("URL:")}   ${dim(prod.product_url || 'N/A')}`);
    origConsoleLog(dim(`------------------------------------------------------`));
  }
}

export function printPricing(results, originalRequests = [], origConsoleLog = console.log) {
  if (!results || results.length === 0) {
    origConsoleLog(yellow(`No pricing results returned.`));
    return;
  }
  origConsoleLog(`\n${bold(cyan("=================== PRICING & STOCK ==================="))}`);
  for (const prod of results) {
    const orig = originalRequests.find(p => p.itemId.toLowerCase() === prod.ProductId.toLowerCase());
    const requestedQty = orig ? orig.qty : 1;
    
    const nzStock = parseInt(prod.OnHandQty, 10) || 0;
    const stockBadge = nzStock > 0 ? green(bold(" [ IN STOCK ]")) : red(bold(" [ OUT OF STOCK ]"));

    origConsoleLog(` ${bold(blue("•"))} ${bold("Item:")} ${cyan(prod.ProductId)} ${dim(`(Req Qty: ${requestedQty})`)}${stockBadge}`);
    origConsoleLog(`   ${bold("Desc:")} ${prod.Description || prod.DisplayName}`);
    
    const buyPrice = prod.AdjustedPriceWithCurrency || `$${prod.NetPrice}`;
    origConsoleLog(`   ${bold("Buy:")}  ${green(buyPrice)}`);
    
    if (SELL_MARGIN_MULTIPLIER !== null) {
      const sellPriceNum = parseFloat((buyPrice).replace(/[^0-9.]/g, '')) * SELL_MARGIN_MULTIPLIER;
      origConsoleLog(`   ${bold("Sell:")} ${yellow(`$${sellPriceNum.toFixed(2)}`)}`);
    }

    if (prod.Discount) origConsoleLog(`   ${bold("Disc:")} ${magenta(prod.Discount)}`);
    
    const nzColor = nzStock > 0 ? green : red;
    origConsoleLog(`   ${bold("NZ Stock:")} ${nzColor(bold(String(prod.OnHandQty)))} ${dim(`(${prod.StockStatusName || prod.StockStatus?.Name || 'Unknown'})`)}`);
    origConsoleLog(`   ${bold("AU Stock:")} ${dim(String(prod.DCOnHandQty))}`);
    origConsoleLog(dim(`-------------------------------------------------------`));
  }
}

function getStatusColor(statusStr) {
  const s = (statusStr || '').toLowerCase();
  if (s.includes('invoiced') || s.includes('complete') || (s.includes('shipped') && !s.includes('partially') && !s.includes('not'))) return green;
  if (s.includes('partially shipped') || s.includes('processing')) return yellow;
  if (s.includes('not shipped') || s.includes('cancel')) return red;
  return cyan;
}

export function printOrders(orders, origConsoleLog = console.log) {
  if (!orders || orders.length === 0) {
    origConsoleLog(yellow(`No orders found.`));
    return;
  }
  origConsoleLog(`\n${bold(cyan("======================= ORDERS ======================="))}`);
  for (const order of orders) {
    origConsoleLog(` ${bold(blue("•"))} ${bold("Order ID:")} ${cyan(order.OrderId || order.OrderID)}`);
    origConsoleLog(`   ${bold("PO:")}       ${yellow(order.PurchaseNumber || 'N/A')}`);
    origConsoleLog(`   ${bold("Date:")}     ${order.OrderDate}`);
    origConsoleLog(`   ${bold("Total:")}    ${green(order.TotalText || order.Total || '$0.00')}`);
    
    const status = order.OrderStatus || order.Status || '';
    const statusColor = getStatusColor(status);
    origConsoleLog(`   ${bold("Status:")}   ${statusColor(status)}`);
    origConsoleLog(dim(`------------------------------------------------------`));
  }
}

export function printInvoices(invoices, origConsoleLog = console.log) {
  if (!invoices || invoices.length === 0) {
    origConsoleLog(yellow(`No invoices found.`));
    return;
  }
  origConsoleLog(`\n${bold(cyan("======================= INVOICES ======================="))}`);
  for (const inv of invoices) {
    origConsoleLog(` ${bold(blue("•"))} ${bold("Invoice No:")} ${cyan(inv.DocumentNumber)}`);
    origConsoleLog(`   ${bold("PO Number:")}  ${inv.PurchaseNumber || 'N/A'} ${dim(`(${inv.CustomerReference || 'No Ref'})`)}`);
    origConsoleLog(`   ${bold("Date:")}       ${inv.InvoiceDate || 'Unknown'}`);
    origConsoleLog(`   ${bold("Total:")}      ${green(inv.TotalText || '$0.00')}`);
    
    if (inv.OutstandingText && inv.OutstandingText !== '$0.00') {
        origConsoleLog(`   ${bold("Outst:")}      ${red(inv.OutstandingText)}`);
    }

    const status = inv.OrderStatus || inv.Status || '';
    const statusColor = getStatusColor(status);
    origConsoleLog(`   ${bold("Status:")}     ${statusColor(status)}`);
    origConsoleLog(dim(`------------------------------------------------------`));
  }
}

function padText(text, width) {
  const stripped = stripColor(text);
  const padding = Math.max(0, width - stripped.length);
  return text + ' '.repeat(padding);
}

function printHeaderGrid(entries, cols = 2, keyWidth = 25, valWidth = 25, origConsoleLog) {
  let row = [];
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    const paddedKey = padText(bold(k + ":"), keyWidth);
    const paddedVal = padText(v, valWidth);
    row.push(paddedKey + paddedVal);
    if (row.length === cols || i === entries.length - 1) {
      origConsoleLog('   ' + row.join(''));
      row = [];
    }
  }
}

function printAddressesGrid(addresses, width = 35, origConsoleLog) {
  const colKeys = Object.keys(addresses);
  if (colKeys.length === 0) return;
  
  const headerRow = colKeys.map(k => padText(bold(blue(k + ":")), width));
  origConsoleLog('   ' + headerRow.join(''));
  
  const columnsData = colKeys.map(k => addresses[k] ? addresses[k].split('\n').map(l => l.trim()) : []);
  const maxLines = Math.max(...columnsData.map(c => c.length));
  
  for (let i = 0; i < maxLines; i++) {
    const row = columnsData.map(col => padText(dim(col[i] || ""), width));
    origConsoleLog('   ' + row.join(''));
  }
}

export function printOrderDetails(data, orderId, origConsoleLog = console.log) {
  const { header, addresses, items } = data || {};
  
  if (header && Object.keys(header).length > 0) {
    origConsoleLog(`\n${bold(cyan("================== ORDER HEADER =================="))}`);
    const entries = [];
    for (const [k, v] of Object.entries(header)) {
      if (v) entries.push([k, v]);
    }
    printHeaderGrid(entries, 2, 26, 25, origConsoleLog);
  }
  
  if (addresses && Object.keys(addresses).length > 0) {
    origConsoleLog(`\n${bold(cyan("================= ORDER ADDRESSES ================="))}`);
    printAddressesGrid(addresses, 35, origConsoleLog);
  }

  if (items && items.length > 0) {
    origConsoleLog(`\n${bold(cyan("=================== ORDER ITEMS ==================="))}`);
    for (const item of items) {
      origConsoleLog(` ${bold(blue("•"))} ${padText(bold("Item:"), 12)} ${cyan(item.ProductCode)}`);
      origConsoleLog(`   ${padText(bold("Desc:"), 12)} ${item.Description}`);
      origConsoleLog(`   ${padText(bold("Price:"), 12)} ${green(item.UnitPrice)}`);
      
      const qtyVal = parseInt(item.Quantity, 10);
      const remVal = parseInt(item.RemainingQuantity, 10);
      
      const qtyColor = qtyVal > 0 ? cyan : (s) => s;
      let remColor = (s) => s;
      if (remVal === 0) remColor = green;
      else if (remVal > 0 && remVal < qtyVal) remColor = yellow;
      else if (remVal === qtyVal) remColor = red;

      origConsoleLog(`   ${padText(bold("Ordered:"), 12)} ${qtyColor(bold(item.Quantity))} ${item.UOM}`);
      origConsoleLog(`   ${padText(bold("Remaining:"), 12)} ${remColor(bold(item.RemainingQuantity))} ${item.UOM}`);
      origConsoleLog(`   ${padText(bold("Total:"), 12)} ${green(item.Total)}`);
      
      const statusColor = getStatusColor(item.Status);
      origConsoleLog(`   ${padText(bold("Status:"), 12)} ${statusColor(item.Status)}`);
      origConsoleLog(dim(`---------------------------------------------------`));
    }
  } else {
    origConsoleLog(yellow(`No items found for order ${orderId}.`));
  }
}

export function printInvoiceDetails(data, invoiceId, origConsoleLog = console.log) {
  const { header, addresses, items } = data || {};
  
  if (header && Object.keys(header).length > 0) {
    origConsoleLog(`\n${bold(cyan("================= INVOICE HEADER ================="))}`);
    const entries = [];
    for (const [k, v] of Object.entries(header)) {
      if (v) entries.push([k, v]);
    }
    printHeaderGrid(entries, 2, 26, 25, origConsoleLog);
  }
  
  if (addresses && Object.keys(addresses).length > 0) {
    origConsoleLog(`\n${bold(cyan("================ INVOICE ADDRESSES ================"))}`);
    printAddressesGrid(addresses, 35, origConsoleLog);
  }

  if (items && items.length > 0) {
    origConsoleLog(`\n${bold(cyan("================== INVOICE ITEMS =================="))}`);
    for (const item of items) {
      origConsoleLog(` ${bold(blue("•"))} ${padText(bold("Item:"), 12)} ${cyan(item.ProductCode)}`);
      origConsoleLog(`   ${padText(bold("Desc:"), 12)} ${item.Description}`);
      origConsoleLog(`   ${padText(bold("Price:"), 12)} ${green(item.UnitPrice)}`);
      
      const qtyVal = parseInt(item.Quantity, 10);
      const qtyColor = qtyVal > 0 ? cyan : dim;
      origConsoleLog(`   ${padText(bold("Qty:"), 12)} ${qtyColor(bold(item.Quantity))}`);
      origConsoleLog(`   ${padText(bold("Total:"), 12)} ${green(item.Total)}`);
      
      origConsoleLog(dim(`---------------------------------------------------`));
    }
  } else {
    origConsoleLog(yellow(`No items found for invoice: ${invoiceId}`));
  }
}
