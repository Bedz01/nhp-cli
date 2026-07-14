# NHPProxy CLI & Library

This package provides a CLI and an API Library to integrate with NHP New
Zealand. You can search products, check pricing, check stock availability,
manage your cart, and pull order/invoice history.

> [!NOTE]
> This tool is currently configured for NHP New Zealand (`nhpnz.co.nz`).
> However, it should also work on the Australian version of the site
> (`nhp.com.au`) with some minor domain and configuration tweaks.

## CLI Usage

The CLI tool is powered by Deno. You can run it directly with
`deno run -A nhp_cli.js`, via `deno task cli`, or install it globally as `nhp`:

```bash
deno install -g -A -f -n nhp nhp_cli.js
```

All dependencies are referenced with explicit versioned specifiers, so the
installed command works from any directory without extra flags.

### Setup

Before running the CLI, you must configure your NHP login details. You can do
this in one of two ways:

**Option 1: credentials.json** Create a `credentials.json` file in the root
directory:

```json
{
  "username": "your_email@example.com",
  "password": "your_password",
  "sellMarginMultiplier": 1.25
}
```
*(Note: `sellMarginMultiplier` is optional. If provided, the CLI will calculate and display a sell price for products).*

**Option 2: Environment Variables** Alternatively, you can export the following
environment variables:

- `NHP_USERNAME`
- `NHP_PASSWORD`
- `NHP_SELL_MARGIN` *(optional)*

Once configured, the CLI will automatically log in on its first run and cache
your session in `cookies.json` (stored alongside the module, no matter which
directory you run from).

### Commands

Run `nhp help` (or `nhp --help`) for the full built-in reference.

**Products & Pricing**

- `nhp search <query>` - Search for products matching a query.
- `nhp price <partNumber...>` - Get price and stock info for one or more part
  numbers.
- `nhp csv <csvFile>` - Get price and stock for part numbers listed in a CSV
  file. Columns: `partNumber[,qty]` - a single-column file of part numbers also
  works (qty defaults to 1), and a header row is skipped automatically.

**Orders & Invoices**

- `nhp orders [offset] [--brief]` - Get order history. Optional search flags:
  `--dateFrom`, `--dateTo`, `--purchaseNumber`, `--documentNumber`,
  `--orderNumber`, `--customerReference`. Add `--brief` for a compact table view.
- `nhp invoices [offset] [--brief]` - Get invoice history. Accepts the same
  optional search flags as orders.
- `nhp order <orderId> [--brief]` - Get detailed line items and shipping status
  for a specific order.
- `nhp invoice <id> [--brief]` - Get detailed line items for a specific invoice.
- `nhp po <query>` - Search order history by PO Number.

**Cart Management**

- `nhp cart add <partNumber> [qty]` - Add an item to the cart. The two-argument
  form treats the second argument as a quantity only when it is 1-9999 with no
  leading zero; anything else (e.g. the numeric part number `06850863`) is
  treated as a second part number. For explicit quantities - including large
  ones - use the `part:qty` form: `nhp cart add K144:2 06850863:10`.
- `nhp cart list` - View current items in the cart.
- `nhp cart remove <partNumber|line#>` - Remove an item, by part number or by
  the line number shown in `cart list`. Part numbers take priority when both
  interpretations are possible.
- `nhp cart update <partNumber|line#> <qty>` - Update the quantity of a cart item.
- `nhp cart clear` - Empty the entire cart.
- `nhp cart upload <csvFilePath>` - Upload a CSV of part numbers to the cart
  (same format as `nhp csv`). The tool verifies every part actually landed in
  the cart and reports any that were rejected.

**Authentication**

- `nhp login` - Force login and refresh cookies.

### JSON Output & Exit Codes

You can append `--json` to any command to receive the raw JSON response on
stdout instead of the formatted terminal output. Progress and error messages go
to stderr, so stdout stays valid JSON for piping:

```bash
nhp orders 0 --purchaseNumber PO-12345 --json > orders.json
```

Failed operations (unknown part numbers on `cart add`, items not found, API
errors) exit with a non-zero status code, so the CLI is safe to script against.

---

## Library API Usage

You can also integrate this package directly into your own JavaScript
applications.

### Import the Library

In Deno (or standard ES module environments), simply import the entry point
`mod.js`.

```javascript
import { NHPClient } from "./mod.js";
```

### Initialization

Create a new instance of the client. By default, it will attempt to read
credentials from `credentials.json` (or environment variables) and persist
session cookies to `cookies.json` next to the module.

```javascript
const client = new NHPClient({
  // Optional configuration overrides:
  cookiePath: "./data/custom_cookies.json",
  credentials: {
    username: "your_email@example.com",
    password: "your_password",
  },
  timeoutMs: 120000, // Per-request timeout (default 120s - the NHP portal is slow)
  silent: true, // Set to true to suppress internal console log messages
});

// Always call ensureLogin() before making API calls
await client.ensureLogin();
```

All requests carry a timeout and automatically re-authenticate once if the
saved session has expired.

### API Methods

#### `searchProducts(query)`

Searches for products matching a keyword.

```javascript
const results = await client.searchProducts("battery");
console.log(results.widgets[0].content); // Array of products
```

#### `getPriceAndStock(products)`

Fetches the current pricing and stock availability (including local NZ and AU
stock). Expects an array of objects containing `itemId` (the part number) and
`qty`.

```javascript
const items = [
  { itemId: "TPHS25R5GM", qty: 1 },
  { itemId: "1756BA1", qty: 5 },
];
const pricingData = await client.getPriceAndStock(items);

// Example response mapping:
for (const prod of pricingData.ChildProducts) {
  if (prod.HasError || prod.ProductExist === false) {
    // Unknown part - the reason is in prod.ErrorMessages
    continue;
  }
  console.log(`Buy Price: ${prod.AdjustedPriceWithCurrency}`);
  console.log(`NZ Stock: ${prod.OnHandQty}`);
}
```

#### `getOrders(pageSize, offset, options)`

Fetches the user's order history. The `options` object can include any
combination of the following search filters: `documentNumber`, `orderNumber`,
`purchaseNumber`, `customerReference`, `dateFrom`, `dateTo`.

```javascript
// Get first 20 orders
const orders = await client.getOrders(20, 0);

// Search for a specific Purchase Order number and Date Range
const poOrders = await client.getOrders(20, 0, {
  purchaseNumber: "PO-12345",
  dateFrom: "01/12/2025",
  dateTo: "06/12/2025",
});
```

#### `getInvoices(pageSize, offset, options)`

Fetches the user's invoice history. The `options` object accepts the same search
filters as `getOrders`.

```javascript
const invoices = await client.getInvoices(20, 0, { dateFrom: "01/01/2026" });
```

#### `getOrderDetails(orderId)`

Fetches specific line items and shipping statuses for a given order ID.

```javascript
const details = await client.getOrderDetails("ORDER_ID_HERE");
console.log(details);
```

#### `getInvoiceDetails(invoiceId)`

Fetches specific line items and pricing for a given invoice ID (Document
Number).

```javascript
const items = await client.getInvoiceDetails("SIN987654321");
console.log(items);
```

#### Cart Management

The library provides complete functionality to manage the user's shopping cart:

```javascript
await client.addToCart("115797", 2);
const cart = await client.getCart();
await client.updateCartLineQuantity(cart.Lines[0].ExternalCartLineId, 5);
await client.removeCartLine(cart.Lines[0].ExternalCartLineId);
await client.clearCart();

// CSV uploads verify the result against the cart, since the NHP upload
// endpoint does not report failures in its response:
const result = await client.uploadCartCsv("./bulk_order.csv");
// -> { success: boolean, requested: string[], missing: string[] }
```

## Development

```bash
deno task check   # lint + type-check + tests
deno task test    # offline unit tests only
```

Offline unit tests live in `tests/` and run in CI on every push.
