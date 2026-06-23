import { green, yellow, red, cyan, bold, dim, blue, magenta, stripColor } from "https://deno.land/std@0.224.0/fmt/colors.ts";

export function printProducts(products, logger) {
  if (!products || products.length === 0) {
    logger.log(yellow(`No products found.`));
    return;
  }
  logger.log(`\n${bold(cyan("=================== SEARCH RESULTS ==================="))}`);
  for (const prod of products) {
    logger.log(` ${bold(blue("•"))} ${bold("SKU:")}   ${cyan(prod.sku)}`);
    logger.log(`   ${bold("Name:")}  ${prod.name || prod.custom_display_name}`);
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
    
    const nzStock = parseInt(prod.OnHandQty, 10) || 0;
    const stockBadge = nzStock > 0 ? green(bold(" [ IN STOCK ]")) : red(bold(" [ OUT OF STOCK ]"));

    logger.log(` ${bold(blue("•"))} ${bold("Item:")} ${cyan(prod.ProductId)} ${dim(`(Req Qty: ${requestedQty})`)}${stockBadge}`);
    logger.log(`   ${bold("Desc:")} ${prod.Description || prod.DisplayName}`);
    
    const buyPrice = prod.AdjustedPriceWithCurrency || `$${prod.NetPrice}`;
    logger.log(`   ${bold("Buy:")}  ${green(buyPrice)}`);
    
    if (config.sellMarginMultiplier !== null && config.sellMarginMultiplier !== undefined) {
      const sellPriceNum = parseFloat((buyPrice).replace(/[^0-9.]/g, '')) * config.sellMarginMultiplier;
      logger.log(`   ${bold("Sell:")} ${yellow(`$${sellPriceNum.toFixed(2)}`)}`);
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

export function printOrders(orders, logger) {
  if (!orders || orders.length === 0) {
    logger.log(yellow(`No orders found.`));
    return;
  }
  logger.log(`\n${bold(cyan("======================= ORDERS ======================="))}`);
  for (const order of orders) {
    logger.log(` ${bold(blue("•"))} ${bold("Order ID:")} ${cyan(order.OrderId || order.OrderID)}`);
    logger.log(`   ${bold("PO:")}       ${yellow(order.PurchaseNumber || 'N/A')}`);
    logger.log(`   ${bold("Date:")}     ${order.OrderDate}`);
    logger.log(`   ${bold("Total:")}    ${green(order.TotalText || order.Total || '$0.00')}`);
    
    const status = order.OrderStatus || order.Status || '';
    const statusColor = getStatusColor(status);
    logger.log(`   ${bold("Status:")}   ${statusColor(status)}`);
    logger.log(dim(`------------------------------------------------------`));
  }
}

export function printInvoices(invoices, logger) {
  if (!invoices || invoices.length === 0) {
    logger.log(yellow(`No invoices found.`));
    return;
  }
  logger.log(`\n${bold(cyan("======================= INVOICES ======================="))}`);
  for (const inv of invoices) {
    logger.log(` ${bold(blue("•"))} ${bold("Invoice No:")} ${cyan(inv.DocumentNumber)}`);
    logger.log(`   ${bold("PO Number:")}  ${inv.PurchaseNumber || 'N/A'} ${dim(`(${inv.CustomerReference || 'No Ref'})`)}`);
    logger.log(`   ${bold("Date:")}       ${inv.InvoiceDate || 'Unknown'}`);
    logger.log(`   ${bold("Total:")}      ${green(inv.TotalText || '$0.00')}`);
    
    if (inv.OutstandingText && inv.OutstandingText !== '$0.00') {
        logger.log(`   ${bold("Outst:")}      ${red(inv.OutstandingText)}`);
    }

    const status = inv.OrderStatus || inv.Status || '';
    const statusColor = getStatusColor(status);
    logger.log(`   ${bold("Status:")}     ${statusColor(status)}`);
    logger.log(dim(`------------------------------------------------------`));
  }
}

function padText(text, width) {
  const stripped = stripColor(text);
  const padding = Math.max(0, width - stripped.length);
  return text + ' '.repeat(padding);
}

function printHeaderGrid(entries, cols = 2, keyWidth = 25, valWidth = 25, logger) {
  let row = [];
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    const paddedKey = padText(bold(k + ":"), keyWidth);
    const paddedVal = padText(v, valWidth);
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
  
  if (header && Object.keys(header).length > 0) {
    logger.log(`\n${bold(cyan("================== ORDER HEADER =================="))}`);
    const entries = [];
    for (const [k, v] of Object.entries(header)) {
      if (v) entries.push([k, v]);
    }
    printHeaderGrid(entries, 2, 26, 25, logger);
  }
  
  if (addresses && Object.keys(addresses).length > 0) {
    logger.log(`\n${bold(cyan("================= ORDER ADDRESSES ================="))}`);
    printAddressesGrid(addresses, 35, logger);
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
  
  if (header && Object.keys(header).length > 0) {
    logger.log(`\n${bold(cyan("================= INVOICE HEADER ================="))}`);
    const entries = [];
    for (const [k, v] of Object.entries(header)) {
      if (v) entries.push([k, v]);
    }
    printHeaderGrid(entries, 2, 26, 25, logger);
  }
  
  if (addresses && Object.keys(addresses).length > 0) {
    logger.log(`\n${bold(cyan("================ INVOICE ADDRESSES ================"))}`);
    printAddressesGrid(addresses, 35, logger);
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

export function printBriefItems(data, logger) {
  const { header, items } = data || {};
  if (!items || items.length === 0) return;
  
  if (header && Object.keys(header).length > 0) {
    const po = header["Purchase order number"] || header["Purchase Number"] || header["PO Number"] || header["PO"] || "N/A";
    const ref = header["Customer Reference"] || header["Reference"] || header["Job Reference"] || "N/A";
    const date = header["Order Created on"] || header["Order Date"] || header["Invoice Date"] || header["Date"] || "Unknown";
    logger.log(` ${dim("PO:")} ${yellow(po)} ${dim("| Ref:")} ${yellow(ref)} ${dim("| Date:")} ${yellow(date)}`);
  }

  for (const item of items) {
    const code = padText(item.ProductCode || 'Unknown', 25);
    logger.log(` ${bold(blue("•"))} ${cyan(code)} ${dim("Qty:")} ${green(bold(String(item.Quantity || 0)))}`);
  }
}

export function printCart(cartData, logger) {
  if (!cartData || !cartData.Lines || cartData.Lines.length === 0) {
    logger.log(yellow(`Cart is empty.`));
    return;
  }
  
  logger.log(`\n${bold(cyan("====================== SHOPPING CART ======================"))} `);
  let index = 1;
  for (const item of cartData.Lines) {
    logger.log(` ${bold(blue(index++ + "."))} ${padText(bold("SKU:"), 10)} ${cyan(item.SKUID)}`);
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
