import { NHPClient } from "./api.js";
import { loadConfig, parseCsv } from "./config.js";
import { printProducts, printPricing, printOrders, printOrderDetails, printInvoices, printInvoiceDetails, printBriefItems, printCart } from "./formatters.js";
import { parseArgs } from "@std/cli/parse-args";
import { Logger } from "./logger.js";
import denoConfig from "./deno.json" with { type: "json" };

function reportApiMessages(results, logger) {
  for (const w of results?.Warnings || []) logger.warn(`[Warning] ${w}`);
  for (const e of results?.Errors || []) logger.error(`[Error] ${e}`);
  return results?.Success !== false && !(results?.Errors?.length > 0);
}

async function findMissingCartParts(client, partNumbers) {
  const cart = await client.getCart();
  const lines = cart?.Lines || [];
  return partNumbers.filter((pn) => !lines.some((l) => l.SKUID?.toLowerCase() === pn.toLowerCase()));
}

// Finds a cart line by part number, internal line ID, or 1-based line number.
// Part numbers can be all-numeric (e.g. 06850863), so exact part number
// matches take priority over line-number interpretation.
function findCartLine(cart, target) {
  const lines = cart?.Lines || [];
  let line = lines.find((l) => l.SKUID?.toLowerCase() === target.toLowerCase() || l.ExternalCartLineId === target);
  if (!line && /^\d+$/.test(target)) {
    const index = parseInt(target, 10) - 1;
    if (index >= 0 && index < lines.length) line = lines[index];
  }
  return line;
}

// Parses `cart add` arguments. Accepted forms:
//   add <part>                      - quantity 1
//   add <part> <qty>                - qty must be 1-9999 with no leading zero;
//                                     anything else is treated as a second part
//                                     number, since part numbers can be numeric
//   add <part>[:qty] <part>[:qty]…  - explicit per-part quantities, any size
export function parseCartAddArgs(userArgs) {
  const QTY_RE = /^[1-9]\d{0,3}$/;
  if (userArgs.length === 2 && !userArgs[0].includes(":") && !userArgs[1].includes(":") && QTY_RE.test(userArgs[1])) {
    return { items: [{ partNumber: userArgs[0], qty: parseInt(userArgs[1], 10) }] };
  }

  const items = [];
  for (const arg of userArgs) {
    if (arg.includes(":")) {
      const [partNumber, qtyStr] = arg.split(":");
      if (!partNumber) {
        return { error: `Invalid item '${arg}': missing part number.` };
      }
      if (!/^[1-9]\d*$/.test(qtyStr || "")) {
        return { error: `Invalid quantity in '${arg}'. Use <partNumber>:<qty> with a positive whole number.` };
      }
      items.push({ partNumber, qty: parseInt(qtyStr, 10) });
    } else {
      items.push({ partNumber: arg, qty: 1 });
    }
  }
  return { items };
}

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
    logger.error("Please specify at least one part number.");
    Deno.exit(1);
  }
  logger.log(`Fetching price and stock for: ${items.join(", ")}...`);

  const productItems = items.map((itemId) => ({ itemId: String(itemId), qty: 1 }));
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
  const offset = parseInt(offsetStr || "0", 10) || 0;

  logger.log(`Fetching orders (offset: ${offset}, pageSize: 20)...`);
  const results = await client.getOrders(20, offset, options);

  logger.json(results);

  if (!logger.isJson) {
    printOrders(results?.NhpOrders || [], logger, options.brief);
  }
}

async function handleInvoices(client, offsetStr, options, logger) {
  const offset = parseInt(offsetStr || "0", 10) || 0;

  logger.log(`Fetching invoices (offset: ${offset}, pageSize: 20)...`);
  const results = await client.getInvoices(20, offset, options);

  logger.json(results);

  if (!logger.isJson) {
    printInvoices(results?.NhpInvoices || [], logger, options.brief);
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
      if (data?.items?.length) {
        printBriefItems(data, logger);
      } else {
        logger.error(`No items found for order ${orderId}. The order may not exist.`);
        Deno.exit(1);
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
      if (data?.items?.length) {
        printBriefItems(data, logger);
      } else {
        logger.error(`No items found for invoice ${invoiceId}. The invoice may not exist.`);
        Deno.exit(1);
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
      logger.log(`Please run 'nhp order <OrderId>' to view details for the desired order.`);
    }
  }
}

async function handleCart(client, args, logger) {
  const subCmd = args[0];
  switch (subCmd) {
    case "add": {
      const userArgs = args.slice(1).filter(Boolean);
      if (userArgs.length === 0) {
        logger.error("Please specify at least one part number to add.");
        Deno.exit(1);
      }

      const { items, error } = parseCartAddArgs(userArgs);
      if (error) {
        logger.error(error);
        Deno.exit(1);
      }

      if (items.length === 1) {
        const item = items[0];
        logger.log(`Adding ${item.qty} of ${item.partNumber} to cart...`);
        const results = await client.addToCart(item.partNumber, item.qty);
        logger.json(results);
        const ok = reportApiMessages(results, logger);
        const missing = ok ? await findMissingCartParts(client, [item.partNumber]) : [item.partNumber];
        if (missing.length === 0) {
          logger.log(`Successfully added ${item.partNumber} to cart.`);
        } else {
          logger.error(`[Failed] ${item.partNumber} was not added to the cart.`);
          Deno.exit(1);
        }
      } else {
        logger.log(`Adding ${items.length} items to cart in bulk...`);
        let csvContent = "Part Number,Quantity\r\n";
        for (const item of items) {
          csvContent += `${item.partNumber},${item.qty}\r\n`;
        }
        const results = await client.uploadCartCsvContent(csvContent, "bulk_add.csv");
        logger.json(results);
        reportApiMessages(results, logger);
        const added = results.requested.length - results.missing.length;
        if (results.missing.length === 0) {
          logger.log(`Successfully added ${added} items to cart.`);
        } else {
          if (added > 0) logger.log(`Added ${added} of ${results.requested.length} items to cart.`);
          for (const pn of results.missing) logger.error(`[Failed] '${pn}' was not added to the cart.`);
          Deno.exit(1);
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
        logger.error("Please specify a part number or line number to remove.");
        Deno.exit(1);
      }
      logger.log(`Removing item '${target}' from cart...`);

      const cart = await client.getCart();
      const line = findCartLine(cart, target);
      if (!line) {
        logger.error(`Item '${target}' not found in cart.`);
        Deno.exit(1);
      }

      const results = await client.removeCartLine(line.ExternalCartLineId);
      logger.json(results);
      const ok = reportApiMessages(results, logger);
      if (ok) {
        logger.log(`Successfully removed ${line.SKUID} from cart.`);
      } else {
        logger.error(`[Failed] Could not remove ${line.SKUID} from cart.`);
        Deno.exit(1);
      }
      break;
    }
    case "update": {
      const target = args[1];
      const quantity = parseInt(args[2] || "", 10);
      if (!target) {
        logger.error("Please specify a part number or line number to update.");
        Deno.exit(1);
      }
      if (isNaN(quantity) || quantity < 0) {
        logger.error("Please specify a valid quantity.");
        Deno.exit(1);
      }

      logger.log(`Updating item '${target}' quantity to ${quantity}...`);

      const cart = await client.getCart();
      const line = findCartLine(cart, target);
      if (!line) {
        logger.error(`Item '${target}' not found in cart.`);
        Deno.exit(1);
      }

      const results = await client.updateCartLineQuantity(line.ExternalCartLineId, quantity);
      logger.json(results);
      const ok = reportApiMessages(results, logger);
      if (ok) {
        logger.log(`Successfully updated ${line.SKUID} to quantity ${quantity}.`);
      } else {
        logger.error(`[Failed] Could not update ${line.SKUID}.`);
        Deno.exit(1);
      }
      break;
    }
    case "clear": {
      logger.log(`Clearing all items from cart...`);
      const results = await client.clearCart();
      logger.json(results);
      const ok = reportApiMessages(results, logger);
      if (ok) {
        logger.log(`Successfully cleared the cart.`);
      } else {
        logger.error(`[Failed] Could not clear the cart.`);
        Deno.exit(1);
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
      reportApiMessages(results, logger);
      const added = results.requested.length - results.missing.length;
      if (results.missing.length === 0) {
        logger.log(`Successfully uploaded CSV to cart (${added} items).`);
      } else {
        if (added > 0) logger.log(`Added ${added} of ${results.requested.length} items to cart.`);
        for (const pn of results.missing) logger.error(`[Failed] '${pn}' was not added to the cart.`);
        Deno.exit(1);
      }
      break;
    }
    default:
      logger.error(`Unknown cart subcommand: ${subCmd}. Available: add, list, remove, update, clear, upload`);
      Deno.exit(1);
  }
}

function showHelp() {
  console.log(`NHP CLI v${denoConfig.version} - NHP New Zealand trade portal client

Usage:
  nhp <command> [options]
  (or: deno run -A nhp_cli.js <command> [options])

Products & Pricing:
  search <query>              Search for products
  price <partNumber...>       Price and stock for one or more part numbers
  csv <file>                  Price and stock for part numbers in a CSV file
                              (columns: partNumber[,qty] - qty defaults to 1)

Orders & Invoices:
  orders [offset] [--brief]   Order history (20 per page)
  invoices [offset] [--brief] Invoice history (20 per page)
  order <orderId> [--brief]   Line items and shipping status for an order
  invoice <id> [--brief]      Line items for an invoice
  po <query>                  Search order history by PO number

Cart:
  cart add <part> [qty]       Add a part to the cart (qty 1-9999)
  cart add <part>[:qty] ...   Add multiple parts (e.g. K144:2 06850863:10)
  cart list                   Show cart contents
  cart remove <part|line#>    Remove an item (by part number or line number)
  cart update <part|line#> <qty>  Change an item's quantity
  cart clear                  Empty the cart
  cart upload <file>          Upload a CSV of parts to the cart

Authentication:
  login                       Force a fresh login and refresh cookies

Options:
  --json                      Print the raw API response as JSON on stdout
  --verbose                   Show debug output (auth flow, etc.)
  --brief                     Compact output for orders/invoices commands
  --dateFrom, --dateTo, --purchaseNumber, --documentNumber,
  --orderNumber, --customerReference
                              Search filters for orders/invoices
  -h, --help                  Show this help
  --version                   Show version

Failed operations exit with a non-zero status code.`);
}

if (import.meta.main) {
  const config = await loadConfig();

  const unknownFlags = [];
  const parsedArgs = parseArgs(Deno.args, {
    boolean: ["json", "verbose", "brief", "help", "version"],
    // "_" keeps positional args as strings - otherwise numeric part numbers
    // like 06850863 get coerced to numbers and lose their leading zeros
    string: ["_", "dateFrom", "dateTo", "purchaseNumber", "documentNumber", "orderNumber", "customerReference"],
    alias: { h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-")) unknownFlags.push(arg);
      return true;
    },
  });

  const { _, json: isJsonMode, verbose, help, h: _h, version, ...options } = parsedArgs;
  const args = _.map(String);

  const logger = new Logger({ isJson: isJsonMode, verbose: verbose });

  if (unknownFlags.length > 0) {
    logger.error(`Unknown flag(s): ${unknownFlags.join(", ")}. Run 'nhp help' for usage.`);
    Deno.exit(1);
  }

  if (version) {
    console.log(`nhp-cli ${denoConfig.version}`);
    Deno.exit(0);
  }

  if (help || args.length === 0 || args[0] === "help") {
    showHelp();
    Deno.exit(0);
  }

  const cmd = args[0];
  const client = new NHPClient({
    silent: isJsonMode,
    logger: logger,
    ...config,
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
        logger.error(`Unknown command: ${cmd}. Run 'nhp help' for usage.`);
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
