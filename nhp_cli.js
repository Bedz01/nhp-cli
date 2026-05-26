import { NHPClient } from "./api.js";
import { parseCsv, printProducts, printPricing, printOrders, printOrderDetails, printInvoices, printInvoiceDetails } from "./utils.js";

if (import.meta.main) {
  let args = [];
  const options = {};
  let isJsonMode = false;
  
  for (let i = 0; i < Deno.args.length; i++) {
    const a = Deno.args[i];
    if (a === "--json") {
      isJsonMode = true;
    } else if (a.startsWith("--")) {
      const key = a.substring(2);
      options[key] = Deno.args[++i];
    } else {
      args.push(a);
    }
  }

  const origConsoleLog = console.log;
  if (isJsonMode) {
    // To prevent inner modules (like API/Auth) from corrupting the JSON stdout:
    console.log = () => {};
  }

  // Use a dedicated log function for standard CLI output
  const stdLog = (...msg) => {
    if (!isJsonMode) {
      origConsoleLog(...msg);
    }
  };
  
  const stdErr = (...msg) => {
    if (!isJsonMode) console.error(...msg);
  };

  if (args.length === 0) {
    // If no args, always show help
    origConsoleLog(`NHP API Client CLI`);
    origConsoleLog(`Usage:`);
    origConsoleLog(`  deno run -A nhp_cli.js <command> [--json]`);
    origConsoleLog(`  Commands:`);
    origConsoleLog(`  deno run -A nhp_cli.js search <query>       - Search for products`);
    origConsoleLog(`  deno run -A nhp_cli.js price <itemId...>    - Get price and stock info for product(s) (qty=1)`);
    origConsoleLog(`  deno run -A nhp_cli.js csv <csvFile>        - Get price and stock for products in a CSV file`);
    origConsoleLog(`  deno run -A nhp_cli.js orders [offset]      - Get order history. Accepts --dateFrom, --dateTo, --purchaseNumber, etc.`);
    origConsoleLog(`  deno run -A nhp_cli.js invoices [offset]    - Get invoice history. Accepts --dateFrom, --dateTo, --purchaseNumber, etc.`);
    origConsoleLog(`  deno run -A nhp_cli.js invoice <id>         - Get invoice details (items)`);
    origConsoleLog(`  deno run -A nhp_cli.js order <orderId>      - Get order details (items)`);
    origConsoleLog(`  deno run -A nhp_cli.js po <query>           - Search order details by PO Number`);
    origConsoleLog(`  deno run -A nhp_cli.js login                - Force login and refresh cookies`);
    Deno.exit(0);
  }

  const cmd = args[0];
  const client = new NHPClient({
    silent: isJsonMode
  });
  
  // Output helper
  const finalize = (data) => {
    if (isJsonMode) {
      origConsoleLog(JSON.stringify(data, null, 2));
    }
  };

  try {
    if (cmd === "login") {
      await client.ensureLogin(true);
      finalize({ success: true });
      stdLog(`[Success] Login completed and cookies saved.`);
    } else if (cmd === "search") {
      const query = args.slice(1).join(" ");
      if (!query) {
        stdErr("Please specify a search query.");
        Deno.exit(1);
      }
      await client.ensureLogin();
      stdLog(`Searching for "${query}"...`);
      const results = await client.searchProducts(query);
      
      finalize(results);
      
      if (!isJsonMode) {
        const products = results?.widgets?.[0]?.content || [];
        printProducts(products, origConsoleLog);
      }
    } else if (cmd === "price") {
      const items = args.slice(1);
      if (items.length === 0) {
        stdErr("Please specify at least one item ID.");
        Deno.exit(1);
      }
      await client.ensureLogin();
      stdLog(`Fetching price and stock for: ${items.join(", ")}...`);
      
      const productItems = items.map(itemId => ({ itemId, qty: 1 }));
      const results = await client.getPriceAndStock(productItems);
      
      finalize(results);
      
      if (!isJsonMode) {
        printPricing(results?.ChildProducts || [], productItems, origConsoleLog);
      }
    } else if (cmd === "csv") {
      const csvFile = args[1];
      if (!csvFile) {
        stdErr("Please specify a CSV file path.");
        Deno.exit(1);
      }
      
      stdLog(`Reading CSV file: ${csvFile}...`);
      const products = await parseCsv(csvFile);
      if (products.length === 0) {
        stdErr("No valid products found in CSV file.");
        Deno.exit(1);
      }
      stdLog(`Parsed ${products.length} products from CSV.`);
      
      await client.ensureLogin();
      
      const allResults = [];
      const batchSize = 20;
      
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        stdLog(`Fetching pricing for batch ${Math.floor(i / batchSize) + 1} (${batch.length} items)...`);
        try {
          const results = await client.getPriceAndStock(batch);
          if (results?.ChildProducts) {
            allResults.push(...results.ChildProducts);
          }
        } catch (err) {
          stdErr(`[Error] Failed to fetch pricing for batch starting at index ${i}:`, err.message);
        }
      }
      
      finalize(allResults);

      if (!isJsonMode) {
        printPricing(allResults, products, origConsoleLog);
      }
    } else if (cmd === "orders") {
      const offsetStr = args[1] || "0";
      const offset = parseInt(offsetStr, 10);
      
      await client.ensureLogin();
      stdLog(`Fetching orders (offset: ${offset}, pageSize: 20)...`);
      const results = await client.getOrders(20, offset, options);
      
      finalize(results);
      
      if (!isJsonMode) {
        printOrders(results?.NhpOrders || [], origConsoleLog);
      }
    } else if (cmd === "invoices") {
      const offsetStr = args[1] || "0";
      const offset = parseInt(offsetStr, 10);
      
      await client.ensureLogin();
      stdLog(`Fetching invoices (offset: ${offset}, pageSize: 20)...`);
      const results = await client.getInvoices(20, offset, options);
      
      finalize(results);
      
      if (!isJsonMode) {
        printInvoices(results?.NhpInvoices || [], origConsoleLog);
      }
    } else if (cmd === "order") {
      const orderId = args[1];
      if (!orderId) {
        stdErr("Please specify an order ID.");
        Deno.exit(1);
      }
      
      stdLog(`Fetching details for order: ${orderId}...`);
      const items = await client.getOrderDetails(orderId);
      
      finalize(items);
      
      if (!isJsonMode) {
        printOrderDetails(items, orderId, origConsoleLog);
      }
    } else if (cmd === "invoice") {
      const invoiceId = args[1];
      if (!invoiceId) {
        stdErr("Please specify an invoice ID.");
        Deno.exit(1);
      }
      
      stdLog(`Fetching details for invoice: ${invoiceId}...`);
      const items = await client.getInvoiceDetails(invoiceId);
      
      finalize(items);
      
      if (!isJsonMode) {
        printInvoiceDetails(items, invoiceId, origConsoleLog);
      }
    } else if (cmd === "po") {
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        stdErr("Please specify a PO string to search for.");
        Deno.exit(1);
      }
      
      stdLog(`Searching for PO matching "${query}"...`);
      await client.ensureLogin();
      
      const res = await client.getOrders(20, 0, { purchaseNumber: query });
      const matchedOrders = res?.NhpOrders || [];
      
      finalize(matchedOrders);
      
      if (!isJsonMode) {
        if (matchedOrders.length === 0) {
          stdLog(`No orders found matching PO "${query}".`);
        } else if (matchedOrders.length === 1) {
          const orderId = matchedOrders[0].OrderId || matchedOrders[0].OrderID;
          stdLog(`Found exactly 1 match (Order: ${orderId}). Fetching details...`);
          const items = await client.getOrderDetails(orderId);
          printOrderDetails(items, orderId, origConsoleLog);
        } else {
          stdLog(`\nFound ${matchedOrders.length} matching orders:`);
          printOrders(matchedOrders, origConsoleLog);
          stdLog(`Please run 'deno run -A nhp_cli.js order <OrderId>' to view details for the desired order.`);
        }
      }
    } else {
      stdErr(`Unknown command: ${cmd}`);
      Deno.exit(1);
    }
  } catch (err) {
    if (isJsonMode) {
      delete console.log;
      console.error(JSON.stringify({ error: err.message }));
    } else {
      stdErr(`Error:`, err.message);
    }
    Deno.exit(1);
  }
}
