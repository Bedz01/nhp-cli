import { NHPClient } from "./api.js";
import { loadConfig, parseCsv } from "./config.js";
import { printProducts, printPricing, printOrders, printOrderDetails, printInvoices, printInvoiceDetails, printBriefItems, printCart } from "./formatters.js";
import { parseArgs } from "jsr:@std/cli/parse-args";
import { Logger } from "./logger.js";

async function handleLogin(client, logger) {
  await client.ensureLogin(true);
  logger.json({ success: true });
  logger.log(`[Success] Login completed and cookies saved.`);
}

async function handleSearch(client, args, logger) {
  const query = args.join(" ");
  if (!query) {
    logger.error("Please specify a search query.");
    Deno.exit(1);
  }
  logger.log(`Searching for "${query}"...`);
  const results = await client.searchProducts(query);
  
  logger.json(results);
  
  if (!logger.isJson) {
    const products = results?.widgets?.[0]?.content || [];
    printProducts(products, logger);
  }
}

async function handlePrice(client, items, config, logger) {
  if (items.length === 0) {
    logger.error("Please specify at least one item ID.");
    Deno.exit(1);
  }
  logger.log(`Fetching price and stock for: ${items.join(", ")}...`);
  
  const productItems = items.map(itemId => ({ itemId: String(itemId), qty: 1 }));
  const results = await client.getPriceAndStock(productItems);
  
  logger.json(results);
  
  if (!logger.isJson) {
    printPricing(results?.ChildProducts || [], productItems, config, logger);
  }
}

async function handleCsv(client, csvFile, config, logger) {
  if (!csvFile) {
    logger.error("Please specify a CSV file path.");
    Deno.exit(1);
  }
  
  logger.log(`Reading CSV file: ${csvFile}...`);
  const products = await parseCsv(csvFile);
  if (products.length === 0) {
    logger.error("No valid products found in CSV file.");
    Deno.exit(1);
  }
  logger.log(`Parsed ${products.length} products from CSV.`);
  
  const allResults = [];
  const batchSize = 20;
  
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    logger.log(`Fetching pricing for batch ${Math.floor(i / batchSize) + 1} (${batch.length} items)...`);
    try {
      const results = await client.getPriceAndStock(batch);
      if (results?.ChildProducts) {
        allResults.push(...results.ChildProducts);
      }
    } catch (err) {
      logger.error(`[Error] Failed to fetch pricing for batch starting at index ${i}:`, err.message);
    }
  }
  
  logger.json(allResults);

  if (!logger.isJson) {
    printPricing(allResults, products, config, logger);
  }
}

async function handleOrders(client, offsetStr, options, logger) {
  const offset = parseInt(offsetStr || "0", 10);
  
  logger.log(`Fetching orders (offset: ${offset}, pageSize: 20)...`);
  const results = await client.getOrders(20, offset, options);
  
  logger.json(results);
  
  if (!logger.isJson) {
    printOrders(results?.NhpOrders || [], logger);
  }
}

async function handleInvoices(client, offsetStr, options, logger) {
  const offset = parseInt(offsetStr || "0", 10);
  
  logger.log(`Fetching invoices (offset: ${offset}, pageSize: 20)...`);
  const results = await client.getInvoices(20, offset, options);
  
  logger.json(results);
  
  if (!logger.isJson) {
    printInvoices(results?.NhpInvoices || [], logger);
  }
}

async function handleOrderDetails(client, orderId, options, logger) {
  if (!orderId) {
    logger.error("Please specify an order ID.");
    Deno.exit(1);
  }
  
  const brief = options?.brief;
  if (!brief) logger.log(`Fetching details for order: ${orderId}...`);
  const data = await client.getOrderDetails(orderId);
  
  logger.json(data);
  
  if (!logger.isJson) {
    if (brief) {
      if (data?.items) {
        printBriefItems(data, logger);
      }
    } else {
      printOrderDetails(data, orderId, logger);
    }
  }
}

async function handleInvoiceDetails(client, invoiceId, options, logger) {
  if (!invoiceId) {
    logger.error("Please specify an invoice ID.");
    Deno.exit(1);
  }
  
  const brief = options?.brief;
  if (!brief) logger.log(`Fetching details for invoice: ${invoiceId}...`);
  const data = await client.getInvoiceDetails(invoiceId);
  
  logger.json(data);
  
  if (!logger.isJson) {
    if (brief) {
      if (data?.items) {
        printBriefItems(data, logger);
      }
    } else {
      printInvoiceDetails(data, invoiceId, logger);
    }
  }
}

async function handlePo(client, args, logger) {
  const query = args.join(" ").trim();
  if (!query) {
    logger.error("Please specify a PO string to search for.");
    Deno.exit(1);
  }
  
  logger.log(`Searching for PO matching "${query}"...`);
  
  const res = await client.getOrders(20, 0, { purchaseNumber: query });
  const matchedOrders = res?.NhpOrders || [];
  
  logger.json(matchedOrders);
  
  if (!logger.isJson) {
    if (matchedOrders.length === 0) {
      logger.log(`No orders found matching PO "${query}".`);
    } else if (matchedOrders.length === 1) {
      const orderId = matchedOrders[0].OrderId || matchedOrders[0].OrderID;
      logger.log(`Found exactly 1 match (Order: ${orderId}). Fetching details...`);
      const items = await client.getOrderDetails(orderId);
      printOrderDetails(items, orderId, logger);
    } else {
      logger.log(`\nFound ${matchedOrders.length} matching orders:`);
      printOrders(matchedOrders, logger);
      logger.log(`Please run 'deno run -A nhp_cli.js order <OrderId>' to view details for the desired order.`);
    }
  }
}

async function handleCart(client, args, logger) {
  const subCmd = args[0];
  switch(subCmd) {
    case "add": {
      const userArgs = args.slice(1);
      if (userArgs.length === 0 || !userArgs[0]) {
        logger.error("Please specify at least one product ID to add.");
        Deno.exit(1);
      }

      let itemsToAdd = [];
      if (userArgs.length === 1 || (userArgs.length === 2 && !isNaN(userArgs[1]) && !userArgs[0].includes(':'))) {
        const productId = userArgs[0];
        const quantity = parseInt(userArgs[1] || "1", 10);
        itemsToAdd.push({ sku: productId, qty: quantity });
      } else {
        for (const arg of userArgs) {
          if (arg.includes(':')) {
            const [sku, qtyStr] = arg.split(':');
            itemsToAdd.push({ sku, qty: parseInt(qtyStr || "1", 10) });
          } else {
            itemsToAdd.push({ sku: arg, qty: 1 });
          }
        }
      }

      if (itemsToAdd.length === 1) {
        const item = itemsToAdd[0];
        logger.log(`Adding ${item.qty} of ${item.sku} to cart...`);
        const results = await client.addToCart(item.sku, item.qty);
        logger.json(results);
        if (!logger.isJson) {
          logger.log(`Successfully added ${item.sku} to cart.`);
        }
      } else {
        logger.log(`Adding ${itemsToAdd.length} items to cart in bulk...`);
        let csvContent = "Part Number,Quantity\r\n";
        for (const item of itemsToAdd) {
          csvContent += `${item.sku},${item.qty}\r\n`;
        }
        const results = await client.uploadCartCsvContent(csvContent, "bulk_add.csv");
        logger.json(results);
        if (!logger.isJson) {
          logger.log(`Successfully added ${itemsToAdd.length} items to cart.`);
        }
      }
      break;
    }
    case "list": {
      logger.log(`Fetching cart items...`);
      const results = await client.getCart();
      logger.json(results);
      if (!logger.isJson) {
        printCart(results, logger);
      }
      break;
    }
    case "remove": {
      const target = args[1];
      if (!target) {
        logger.error("Please specify a SKU or Line ID to remove.");
        Deno.exit(1);
      }
      logger.log(`Removing item '${target}' from cart...`);
      
      const cart = await client.getCart();
      let line;
      if (/^\d+$/.test(target)) {
        const index = parseInt(target, 10) - 1;
        line = cart?.Lines?.[index];
      } else {
        line = cart?.Lines?.find(l => l.SKUID.toLowerCase() === target.toLowerCase() || l.ExternalCartLineId === target);
      }
      
      if (!line) {
        logger.error(`Item '${target}' not found in cart.`);
        Deno.exit(1);
      }
      
      const results = await client.removeCartLine(line.ExternalCartLineId);
      logger.json(results);
      if (!logger.isJson) {
        logger.log(`Successfully removed ${line.SKUID} from cart.`);
      }
      break;
    }
    case "update": {
      const target = args[1];
      const quantity = parseInt(args[2] || "1", 10);
      if (!target) {
        logger.error("Please specify a SKU or Line ID to update.");
        Deno.exit(1);
      }
      if (isNaN(quantity) || quantity < 0) {
        logger.error("Please specify a valid quantity.");
        Deno.exit(1);
      }
      
      logger.log(`Updating item '${target}' quantity to ${quantity}...`);
      
      const cart = await client.getCart();
      let line;
      if (/^\d+$/.test(target)) {
        const index = parseInt(target, 10) - 1;
        line = cart?.Lines?.[index];
      } else {
        line = cart?.Lines?.find(l => l.SKUID.toLowerCase() === target.toLowerCase() || l.ExternalCartLineId === target);
      }
      
      if (!line) {
        logger.error(`Item '${target}' not found in cart.`);
        Deno.exit(1);
      }
      
      const results = await client.updateCartLineQuantity(line.ExternalCartLineId, quantity);
      logger.json(results);
      if (!logger.isJson) {
        logger.log(`Successfully updated ${line.SKUID} to quantity ${quantity}.`);
      }
      break;
    }
    case "clear": {
      logger.log(`Clearing all items from cart...`);
      const results = await client.clearCart();
      logger.json(results);
      if (!logger.isJson) {
        logger.log(`Successfully cleared the cart.`);
      }
      break;
    }
    case "upload": {
      const csvFilePath = args[1];
      if (!csvFilePath) {
        logger.error("Please specify a CSV file path to upload.");
        Deno.exit(1);
      }
      logger.log(`Uploading cart CSV '${csvFilePath}'...`);
      const results = await client.uploadCartCsv(csvFilePath);
      logger.json(results);
      if (!logger.isJson) {
        logger.log(`Successfully uploaded CSV to cart.`);
      }
      break;
    }
    default:
      logger.error(`Unknown cart subcommand: ${subCmd}. Available: add, list, remove, update, clear, upload`);
      Deno.exit(1);
  }
}

function showHelp(logger) {
  logger.log(`NHP API Client CLI`);
  logger.log(`Usage:`);
  logger.log(`  deno run -A nhp_cli.js <command> [--json] [--verbose]`);
  logger.log(`  Commands:`);
  logger.log(`  deno run -A nhp_cli.js search <query>       - Search for products`);
  logger.log(`  deno run -A nhp_cli.js price <itemId...>    - Get price and stock info for product(s) (qty=1)`);
  logger.log(`  deno run -A nhp_cli.js csv <csvFile>        - Get price and stock for products in a CSV file`);
  logger.log(`  deno run -A nhp_cli.js orders [offset]      - Get order history. Accepts --dateFrom, --dateTo, --purchaseNumber, etc.`);
  logger.log(`  deno run -A nhp_cli.js invoices [offset]    - Get invoice history. Accepts --dateFrom, --dateTo, --purchaseNumber, etc.`);
  logger.log(`  deno run -A nhp_cli.js invoice <id> [--brief] - Get invoice details (items)`);
  logger.log(`  deno run -A nhp_cli.js order <orderId> [--brief]- Get order details (items)`);
  logger.log(`  deno run -A nhp_cli.js po <query>           - Search order details by PO Number`);
  logger.log(`  deno run -A nhp_cli.js cart <subcommand>    - Manage cart (add, list, remove, update, clear, upload)`);
  logger.log(`  deno run -A nhp_cli.js login                - Force login and refresh cookies`);
}

if (import.meta.main) {
  const config = await loadConfig();
  
  const parsedArgs = parseArgs(Deno.args, {
    boolean: ["json", "verbose", "brief"],
  });
  
  const { _, json: isJsonMode, verbose, ...options } = parsedArgs;
  const args = _.map(String);
  
  const logger = new Logger({ isJson: isJsonMode, verbose: verbose });

  if (args.length === 0) {
    showHelp(logger);
    Deno.exit(0);
  }

  const cmd = args[0];
  const client = new NHPClient({
    silent: isJsonMode, 
    logger: logger,
    ...config 
  });

  try {
    switch (cmd) {
      case "login":
        await handleLogin(client, logger);
        break;
      case "search":
        await handleSearch(client, args.slice(1), logger);
        break;
      case "price":
        await handlePrice(client, args.slice(1), config, logger);
        break;
      case "csv":
        await handleCsv(client, args[1], config, logger);
        break;
      case "orders":
        await handleOrders(client, args[1], options, logger);
        break;
      case "invoices":
        await handleInvoices(client, args[1], options, logger);
        break;
      case "order":
        await handleOrderDetails(client, args[1], options, logger);
        break;
      case "invoice":
        await handleInvoiceDetails(client, args[1], options, logger);
        break;
      case "po":
        await handlePo(client, args.slice(1), logger);
        break;
      case "cart":
        await handleCart(client, args.slice(1), logger);
        break;
      default:
        logger.error(`Unknown command: ${cmd}`);
        Deno.exit(1);
    }
  } catch (err) {
    if (isJsonMode) {
      logger.error(JSON.stringify({ error: err.message, status: err.statusCode }));
    } else {
      logger.error(`Error:`, err.message);
    }
    Deno.exit(1);
  }
}
