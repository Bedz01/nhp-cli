import { NHPClient } from "./api.js";
import { parseCsv } from "./config.js";
import {
  configDir,
  deleteCredentials,
  deleteSession,
  fileExists,
  legacyPath,
  loadSettings,
  resolveCredentials,
  saveCredentials,
  saveSettings,
  SESSION_FILE,
} from "./store.js";
import { isInteractive, promptCredentials } from "./prompt.js";
import {
  INVOICE_ITEM_TSV_COLUMNS,
  INVOICE_LIST_TSV_COLUMNS,
  invoiceDetailView,
  invoiceItemTsvRows,
  invoiceListTsvRows,
  ORDER_ITEM_TSV_COLUMNS,
  ORDER_LIST_TSV_COLUMNS,
  orderDetailView,
  orderItemTsvRows,
  orderListTsvRows,
  PRICE_TSV_COLUMNS,
  priceTsvRows,
  printBriefItems,
  printCart,
  printInvoiceDetails,
  printInvoices,
  printOrderDetails,
  printOrders,
  printPriceLedger,
  printPricing,
  printProducts,
  printTsv,
} from "./formatters.js";
import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { Logger } from "./logger.js";
import denoConfig from "./deno.json" with { type: "json" };

// Cart responses carry a `messages` list ({ message, messageType }); surface
// warnings/errors from it and report whether any were errors.
function reportApiMessages(results, logger) {
  let ok = true;
  for (const m of results?.messages || []) {
    if (m.messageType === "error") {
      logger.error(`[Error] ${m.message}`);
      ok = false;
    } else if (m.messageType && m.messageType !== "success") {
      logger.warn(`[Warning] ${m.message}`);
    }
  }
  return ok;
}

function cartHasPart(cart, partNumber) {
  return (cart?.lineItems || []).some((l) => l.productID?.toLowerCase() === partNumber.toLowerCase());
}

// Finds a cart line by part number, internal line ID, or 1-based line number.
// Part numbers can be all-numeric (e.g. 06850863), so exact part number
// matches take priority over line-number interpretation.
function findCartLine(cart, target) {
  const lines = cart?.lineItems || [];
  let line = lines.find((l) => l.productID?.toLowerCase() === target.toLowerCase() || l.id === target);
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

// Parses `price` arguments: <part>[:qty] ... Only the explicit form sets a
// quantity - unlike `cart add`, a bare number here is always a part number,
// because a price check routinely takes many parts and NHP part numbers can
// be all digits, so a second-argument heuristic would misread them. Parts
// without a :qty get `defaultQty` (--qty).
export function parsePartQtyArgs(userArgs, defaultQty = 1) {
  const items = [];
  for (const arg of userArgs) {
    if (arg.includes(":")) {
      const [itemId, qtyStr, ...rest] = arg.split(":");
      if (!itemId || rest.length > 0) return { error: `Invalid item '${arg}': use <partNumber>:<qty>.` };
      if (!/^[1-9]\d*$/.test(qtyStr || "")) return { error: `Invalid quantity in '${arg}'. Use <partNumber>:<qty> with a positive whole number.` };
      items.push({ itemId, qty: parseInt(qtyStr, 10) });
    } else {
      items.push({ itemId: arg, qty: defaultQty });
    }
  }
  return { items };
}

function describeItems(items) {
  return items.map((i) => (i.qty === 1 ? i.itemId : `${i.itemId} x${i.qty}`)).join(", ");
}

// price/csv output: the ledger is the default, --full restores the record
// view, --tsv exports; --json has already printed and wants nothing else.
function printPriceResults(products, options, config, logger) {
  if (options.tsv) printTsv(PRICE_TSV_COLUMNS, priceTsvRows(products, config), logger);
  else if (logger.isJson) return;
  else if (options.full) printPricing(products, config, logger);
  else printPriceLedger(products, config, logger);
}

// Credentials for the client, resolved only when a login is actually needed:
// env vars or the stored file silently; with neither, a person at a terminal
// is asked and the answer is saved once the login succeeds (onLogin below).
function credentialsProvider(state, interactive, logger) {
  return async () => {
    const creds = await resolveCredentials();
    if (creds) {
      if (creds.source === "legacy") logger.warn(`[Notice] Using ${creds.path}. Run 'nhp login' once to move it to ${configDir()}.`);
      return creds;
    }
    if (!interactive) throw new Error("No saved login. Run 'nhp login', or set NHP_USERNAME and NHP_PASSWORD.");
    logger.log(`No saved login. Enter your NHP portal credentials; they will be kept in ${configDir()}.`);
    state.prompted = await promptCredentials();
    return state.prompted;
  };
}

async function rememberCredentials(creds, logger) {
  const saved = await saveCredentials(creds);
  if (saved.warning) logger.warn(`[Warning] ${saved.warning}`);
  logger.log(`Saved credentials to ${saved.path}${saved.encrypted ? " (password encrypted with Windows DPAPI)" : ""}.`);
  return saved;
}

async function handleLogin(client, options, logger, interactive) {
  if (options.reset && await deleteCredentials()) logger.log(`Removed the stored credentials.`);

  let creds = await resolveCredentials();
  let prompted = false;
  if (!creds) {
    if (!interactive) throw new Error("No saved login and no terminal to ask on. Set NHP_USERNAME and NHP_PASSWORD, or run 'nhp login' from a terminal.");
    logger.log(`Enter your NHP portal (nhpnz.co.nz) credentials. They will be kept in ${configDir()}.`);
    creds = await promptCredentials();
    prompted = true;
  } else {
    const from = creds.source === "env" ? "from NHP_USERNAME/NHP_PASSWORD" : `from ${creds.path}`;
    logger.log(`Logging in as ${creds.username} (${from})...`);
  }

  client.credentials = { username: creds.username, password: creds.password };
  await client.ensureLogin(true);

  let saved = null;
  if (prompted || creds.source === "legacy") {
    saved = await rememberCredentials(creds, logger);
    if (creds.source === "legacy") {
      // The old file held the margin too; carry it over so the old file is
      // no longer consulted for anything.
      const settings = await loadSettings({});
      if (settings.sellMarginMultiplier !== null) await saveSettings({ sellMarginMultiplier: settings.sellMarginMultiplier });
      logger.log(`Migrated from ${creds.path}; that file is no longer read and can be deleted.`);
    }
  }

  logger.json({ success: true, username: creds.username, source: prompted ? "prompt" : creds.source, credentialsPath: saved?.path ?? null, sessionPath: String(client.cookiePath) });
  logger.log(`[Success] Logged in as ${creds.username}. Session saved to ${client.cookiePath}.`);
}

async function handleLogout(logger) {
  const session = await deleteSession();
  const creds = await deleteCredentials();
  logger.json({ success: true, sessionRemoved: session, credentialsRemoved: creds });
  const what = [session && "the saved session", creds && "the stored credentials"].filter(Boolean).join(" and ");
  logger.log(what ? `Removed ${what} from ${configDir()}.` : `Nothing to remove in ${configDir()}.`);
  for (const name of [SESSION_FILE, "credentials.json"]) {
    if (await fileExists(legacyPath(name))) logger.warn(`[Notice] An old ${name} still exists at ${legacyPath(name)}; delete it or it will be picked up again.`);
  }
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

async function handlePrice(client, args, options, config, logger) {
  const defaultQty = parseInt(options.qty || "1", 10);
  if (isNaN(defaultQty) || defaultQty < 1) {
    logger.error("Please specify a valid --qty (positive whole number).");
    Deno.exit(1);
  }
  const { items: productItems, error } = parsePartQtyArgs(args, defaultQty);
  if (error) {
    logger.error(error);
    Deno.exit(1);
  }
  if (productItems.length === 0) {
    logger.error("Please specify at least one part number.");
    Deno.exit(1);
  }
  logger.log(`Fetching price and stock for: ${describeItems(productItems)}...`);

  const results = await client.getPriceAndStock(productItems);

  logger.json(results);
  printPriceResults(results?.products || [], options, config, logger);
}

async function handleCsv(client, csvFile, options, config, logger) {
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
  logger.log(`Fetching pricing for ${products.length} items...`);

  // The client chunks id lists to the portal's 20-per-request cap itself; an
  // unknown part comes back as an entry with `error` set, not a throw.
  const results = await client.getPriceAndStock(products);

  logger.json(results);
  printPriceResults(results?.products || [], options, config, logger);
}

async function handleOrders(client, pageStr, options, logger) {
  const page = parseInt(pageStr || "1", 10) || 1;

  logger.log(`Fetching orders (page ${page}, 20 per page)...`);
  const results = await client.getOrders(20, page, options);

  logger.json(results);

  if (options.tsv) {
    printTsv(ORDER_LIST_TSV_COLUMNS, orderListTsvRows(results?.items || []), logger);
  } else if (!logger.isJson) {
    // The ledger view is the default for order lists; --full restores the record view.
    printOrders(results?.items || [], logger, !options.full);
    if (results?.meta?.totalPages > 1) logger.log(`Page ${results.meta.page} of ${results.meta.totalPages} (${results.meta.totalCount} orders). 'nhp orders ${page + 1}' for the next page.`);
  }
}

async function handleInvoices(client, pageStr, options, logger) {
  const page = parseInt(pageStr || "1", 10) || 1;

  logger.log(`Fetching invoices (page ${page}, 20 per page)...`);
  const results = await client.getInvoices(20, page, options);

  logger.json(results);

  if (options.tsv) {
    printTsv(INVOICE_LIST_TSV_COLUMNS, invoiceListTsvRows(results?.items || []), logger);
  } else if (!logger.isJson) {
    printInvoices(results?.items || [], logger, options.brief);
    if (results?.meta?.totalPages > 1) logger.log(`Page ${results.meta.page} of ${results.meta.totalPages} (${results.meta.totalCount} invoices). 'nhp invoices ${page + 1}' for the next page.`);
  }
}

async function handleOrderDetails(client, orderIds, options, logger) {
  if (orderIds.length === 0) {
    logger.error("Please specify an order ID.");
    Deno.exit(1);
  }

  // The item ledger is the default; --full restores the header/address/item
  // record view; --tsv is the spreadsheet export and wins over --full (the
  // logger mutes the progress line in that mode).
  const tsv = !!options?.tsv;
  const brief = !options?.full;
  if (!brief) {
    const what = orderIds.length === 1 ? `order: ${orderIds[0]}` : `${orderIds.length} orders`;
    logger.log(`Fetching details for ${what}...`);
  }

  // A failure is kept per order instead of sinking the rest of the batch.
  const results = [];
  for (const orderId of orderIds) {
    try {
      results.push({ orderId, data: await client.getOrderDetails(orderId), error: null });
    } catch (err) {
      results.push({ orderId, data: null, error: err });
    }
  }

  // One order keeps the original JSON contract: the bare scrape result, and a
  // failure thrown to the top-level handler. Several orders emit an array with
  // one entry per requested order, in the order asked for - a failed lookup
  // becoming an { orderId, error } entry so the positions still line up with
  // the arguments.
  if (results.length === 1) {
    if (results[0].error) throw results[0].error;
    logger.json(results[0].data);
  } else {
    logger.json(results.map((r) => r.error ? { orderId: r.orderId, error: r.error.message } : r.data));
  }

  let failed = false;

  if (!logger.isJson) {
    results.forEach(({ orderId, data, error }, i) => {
      if (i > 0 && brief) logger.log("");
      if (error) {
        logger.error(`Error fetching order ${orderId}:`, error.message);
        failed = true;
      } else if (brief || tsv) {
        if (!data?.lineItems?.length) {
          logger.error(`No items found for order ${orderId}. The order may not exist.`);
          failed = true;
        } else if (!tsv) {
          printBriefItems(orderDetailView(data), logger, orderId);
        }
      } else {
        printOrderDetails(data, orderId, logger);
      }
    });
    if (tsv) {
      const rows = results.filter((r) => !r.error).flatMap((r) => orderItemTsvRows(r.data, r.orderId));
      printTsv(ORDER_ITEM_TSV_COLUMNS, rows, logger);
    }
  }

  if (failed || results.some((r) => r.error)) Deno.exit(1);
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
    if (brief || options?.tsv) {
      if (!data?.lineItems?.length) {
        logger.error(`No items found for invoice ${invoiceId}. The invoice may not exist.`);
        Deno.exit(1);
      } else if (options?.tsv) {
        printTsv(INVOICE_ITEM_TSV_COLUMNS, invoiceItemTsvRows(data, invoiceId), logger);
      } else {
        printBriefItems(invoiceDetailView(data), logger, invoiceId, "Invoice");
      }
    } else {
      printInvoiceDetails(data, invoiceId, logger);
    }
  }
}

async function handlePo(client, args, options, logger) {
  const query = args.join(" ").trim();
  if (!query) {
    logger.error("Please specify a PO string to search for.");
    Deno.exit(1);
  }

  logger.log(`Searching for PO matching "${query}"...`);

  const res = await client.getOrders(20, 1, { purchaseNumber: query });
  const matchedOrders = res?.items || [];

  logger.json(matchedOrders);

  if (!logger.isJson) {
    if (matchedOrders.length === 0) {
      // --tsv still gets a well-formed (header-only) table, like an empty order.
      if (options?.tsv) printTsv(ORDER_LIST_TSV_COLUMNS, [], logger);
      else logger.log(`No orders found matching PO "${query}".`);
    } else if (matchedOrders.length === 1) {
      const orderId = matchedOrders[0].orderNo;
      logger.log(`Found exactly 1 match (Order: ${orderId}). Fetching details...`);
      const data = await client.getOrderDetails(orderId);
      // Same defaults as `order <id>`: ledger unless --full; --tsv exports.
      if (options?.tsv) printTsv(ORDER_ITEM_TSV_COLUMNS, orderItemTsvRows(data, orderId), logger);
      else if (options?.full) printOrderDetails(data, orderId, logger);
      else printBriefItems(orderDetailView(data), logger, orderId);
    } else if (options?.tsv) {
      printTsv(ORDER_LIST_TSV_COLUMNS, orderListTsvRows(matchedOrders), logger);
    } else {
      logger.log(`\nFound ${matchedOrders.length} matching orders:`);
      printOrders(matchedOrders, logger, true);
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
        // The add responds with the whole cart; verify the part landed in it.
        if (ok && cartHasPart(results, item.partNumber)) {
          logger.log(`Successfully added ${item.partNumber} to cart.`);
        } else {
          logger.error(`[Failed] ${item.partNumber} was not added to the cart.`);
          Deno.exit(1);
        }
      } else {
        logger.log(`Adding ${items.length} items to cart in bulk...`);
        const results = await client.addToCartBatch(items.map((i) => ({ itemId: i.partNumber, qty: i.qty })));
        logger.json(results);
        const failed = results.errors || [];
        const added = items.length - failed.length;
        if (failed.length === 0) {
          logger.log(`Successfully added ${added} items to cart.`);
        } else {
          if (added > 0) logger.log(`Added ${added} of ${items.length} items to cart.`);
          for (const e of failed) logger.error(`[Failed] '${e.productID}' was not added: ${e.message}`);
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

      const results = await client.removeCartLine(line.id);
      logger.json(results);
      const ok = reportApiMessages(results, logger) && !cartHasPart(results, line.productID);
      if (ok) {
        logger.log(`Successfully removed ${line.productID} from cart.`);
      } else {
        logger.error(`[Failed] Could not remove ${line.productID} from cart.`);
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

      const results = await client.updateCartLineQuantity(line, quantity);
      logger.json(results);
      const ok = reportApiMessages(results, logger);
      if (ok) {
        logger.log(`Successfully updated ${line.productID} to quantity ${quantity}.`);
      } else {
        logger.error(`[Failed] Could not update ${line.productID}.`);
        Deno.exit(1);
      }
      break;
    }
    case "clear": {
      logger.log(`Clearing all items from cart...`);
      const results = await client.clearCart();
      logger.json(results);
      logger.log(results.cleared === 0 ? `Cart was already empty.` : `Successfully cleared the cart (${results.cleared} line${results.cleared === 1 ? "" : "s"}).`);
      break;
    }
    case "from-order": {
      const orderIds = args.slice(1).filter(Boolean);
      if (orderIds.length === 0) {
        logger.error("Please specify one or more order IDs (e.g. SOR1314816).");
        Deno.exit(1);
      }

      // Same multi-record contract as `order`: one bad order never sinks the
      // rest, --json lines up with the arguments, non-zero exit on any failure.
      const results = [];
      let failed = false;
      for (const orderId of orderIds) {
        logger.log(`Adding items from order ${orderId} to cart...`);
        try {
          const res = await client.addOrderToCart(orderId);
          results.push(res);
          const added = res.items.length - res.errors.length;
          if (res.items.length === 0) {
            logger.error(`No addable lines on order ${orderId}. The order may not exist or all its lines are cancelled.`);
            failed = true;
          } else if (res.errors.length === 0) {
            logger.log(`Added ${added} item${added === 1 ? "" : "s"} from ${orderId} to cart.`);
          } else {
            if (added > 0) logger.log(`Added ${added} of ${res.items.length} items from ${orderId} to cart.`);
            for (const e of res.errors) logger.error(`[Failed] '${e.productID}' was not added: ${e.message}`);
            failed = true;
          }
        } catch (err) {
          results.push({ orderId, error: err.message });
          logger.error(`Error adding order ${orderId}:`, err.message);
          failed = true;
        }
      }
      logger.json(results.length === 1 ? results[0] : results);
      if (failed) Deno.exit(1);
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
      for (const w of results.Warnings || []) logger.warn(`[Warning] ${w}`);
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
      logger.error(`Unknown cart subcommand: ${subCmd}. Available: add, list, remove, update, clear, upload, from-order`);
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
  price <part>[:qty]... [--full|--tsv]
                              Price and stock for one or more part numbers
                              (ledger by default, e.g. K144:2 06850863:10)
  csv <file> [--full|--tsv]   Price and stock for part numbers in a CSV file
                              (columns: partNumber[,qty] - qty defaults to 1)

Orders & Invoices:
  orders [page] [--full|--tsv]
                              Order history (20 per page, ledger by default)
  invoices [page] [--brief|--tsv]
                              Invoice history (20 per page)
  order <orderId...> [--full|--tsv]
                              Line items and shipping status for one or more
                              orders, e.g. SOR1314816 (ledger by default)
  invoice <id> [--brief|--tsv]
                              Line items for an invoice, e.g. SIN02755715
  po <query> [--full|--tsv]   Search order history by PO number

Cart:
  cart add <part> [qty]       Add a part to the cart (qty 1-9999)
  cart add <part>[:qty] ...   Add multiple parts (e.g. K144:2 06850863:10)
  cart list                   Show cart contents
  cart remove <part|line#>    Remove an item (by part number or line number)
  cart update <part|line#> <qty>  Change an item's quantity
  cart clear                  Empty the cart
  cart upload <file>          Upload a CSV of parts to the cart
  cart from-order <id...>     Re-add a previous order's items to the cart

Authentication:
  login [--reset]             Log in and save the session. Asks for your
                              username and password the first time (or with
                              --reset) and remembers them; otherwise re-logs
                              in with the saved ones.
  logout                      Forget the saved session and credentials

Options:
  --json                      Print the raw API response as JSON on stdout
  --verbose                   Show debug output (auth flow, etc.)
  --brief                     One-line ledger output for invoices/invoice
                              (already the default for price/csv/orders/order/po)
  --full                      Record view for price/csv/orders/order/po
  --qty <n>                   Default quantity for price (parts without :qty)
  --tsv                       Tab-separated table for price/csv/orders/order/
                              invoices/invoice/po (pipe to Set-Clipboard / clip
                              and paste into a spreadsheet)
  --dateFrom, --dateTo        Date range filters for orders/invoices (yyyy-mm-dd)
  --purchaseNumber, --documentNumber, --orderNumber, --customerReference
                              Search filters for orders/invoices. The portal
                              has one search box, so these all feed the same
                              free-text match.
  -h, --help                  Show this help
  --version                   Show version

State (override the directory with NHP_CONFIG_DIR):
  ${configDir()}
  config.json       { "sellMarginMultiplier": 1.25 }   (env: NHP_SELL_MARGIN)
  credentials.json  saved by 'login'; the password is DPAPI-encrypted on
                    Windows             (env: NHP_USERNAME, NHP_PASSWORD)
  cookies.json      the portal session

Failed operations exit with a non-zero status code.`);
}

if (import.meta.main) {
  const config = await loadSettings();

  const unknownFlags = [];
  const parsedArgs = parseArgs(Deno.args, {
    boolean: ["json", "verbose", "brief", "full", "tsv", "reset", "help", "version"],
    // "_" keeps positional args as strings - otherwise numeric part numbers
    // like 06850863 get coerced to numbers and lose their leading zeros
    string: ["_", "qty", "dateFrom", "dateTo", "purchaseNumber", "documentNumber", "orderNumber", "customerReference"],
    alias: { h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-")) unknownFlags.push(arg);
      return true;
    },
  });

  const { _, json: isJsonMode, verbose, help, h: _h, version, ...options } = parsedArgs;
  const args = _.map(String);

  const logger = new Logger({ isJson: isJsonMode, isTsv: options.tsv, verbose: verbose });

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
  // A prompt is only possible with a person on a terminal and stdout not
  // carrying a machine payload.
  const interactive = isInteractive() && !isJsonMode && !options.tsv;
  const state = { prompted: null };
  const client = new NHPClient({
    silent: isJsonMode || options.tsv,
    logger: logger,
    credentials: credentialsProvider(state, interactive, logger),
    // Prompted credentials are saved as soon as the portal accepts them, so
    // a later failure in the command itself cannot lose them.
    onLogin: async (creds) => { if (state.prompted && creds === state.prompted) await rememberCredentials(creds, logger); },
  });

  try {
    switch (cmd) {
      case "login":
        await handleLogin(client, options, logger, interactive);
        break;
      case "logout":
        await handleLogout(logger);
        break;
      case "search":
        await handleSearch(client, args.slice(1), logger);
        break;
      case "price":
        await handlePrice(client, args.slice(1), options, config, logger);
        break;
      case "csv":
        await handleCsv(client, args[1], options, config, logger);
        break;
      case "orders":
        await handleOrders(client, args[1], options, logger);
        break;
      case "invoices":
        await handleInvoices(client, args[1], options, logger);
        break;
      case "order":
        await handleOrderDetails(client, args.slice(1), options, logger);
        break;
      case "invoice":
        await handleInvoiceDetails(client, args[1], options, logger);
        break;
      case "po":
        await handlePo(client, args.slice(1), options, logger);
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
