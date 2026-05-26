# NHPProxy CLI & Library

This package provides a CLI and an API Library to integrate with NHP New
Zealand. You can search products, check pricing, check stock availability, and
pull order/invoice history.

> [!NOTE]
> This tool is currently configured for NHP New Zealand (`nhpnz.co.nz`).
> However, it should also work on the Australian version of the site
> (`nhp.com.au`) with some minor domain and configuration tweaks.

## CLI Usage

The CLI tool is powered by Deno. You can run it directly using `nhp_cli.js` (or
via `deno task cli`).

### Setup

Before running the CLI, you must configure your NHP login details. You can do
this in one of two ways:

**Option 1: credentials.json** Create a `credentials.json` file in the root
directory:

```json
{
  "username": "your_email@example.com",
  "password": "your_password"
}
```

**Option 2: Environment Variables** Alternatively, you can export the following
environment variables:

- `NHP_USERNAME`
- `NHP_PASSWORD`

Once configured, the CLI will automatically log in on its first run and cache
your session in `cookies.json`.

### Commands

**Authentication**

- `deno run -A nhp_cli.js login` - Force login and refresh cookies.

**Products & Pricing**

- `deno run -A nhp_cli.js search <query>` - Search for products matching a
  query.
- `deno run -A nhp_cli.js price <itemId...>` - Get price and stock info for
  specific product(s).
- `deno run -A nhp_cli.js csv <csvFile>` - Get price and stock for products
  listed in a CSV file.

**Orders & Invoices**

- `deno run -A nhp_cli.js orders [offset]` - Get order history. Optional search
  flags: `--dateFrom`, `--dateTo`, `--purchaseNumber`, `--documentNumber`,
  `--orderNumber`, `--customerReference`.
- `deno run -A nhp_cli.js invoices [offset]` - Get invoice history. Accepts the
  same optional search flags as orders.
- `deno run -A nhp_cli.js order <orderId>` - Get detailed line items and
  shipping status for a specific order.
- `deno run -A nhp_cli.js invoice <id>` - Get detailed line items for a specific
  invoice.
- `deno run -A nhp_cli.js po <query>` - Search order history by PO Number.

### JSON Output

You can append `--json` to any command to receive the raw JSON response instead
of the formatted terminal output. This is highly useful for chaining commands or
piping data into other applications.

```bash
deno run -A nhp_cli.js orders 0 --purchaseNumber PO-12345 --json > orders.json
```

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
session cookies to `cookies.json`.

```javascript
const client = new NHPClient({
  // Optional configuration overrides:
  cookiePath: "./data/custom_cookies.json",
  credentials: {
    username: "your_email@example.com",
    password: "your_password",
  },
  silent: true, // Set to true to suppress internal console log messages
});

// Always call ensureLogin() before making API calls
await client.ensureLogin();
```

### API Methods

#### `searchProducts(query)`

Searches for products matching a keyword.

```javascript
const results = await client.searchProducts("battery");
console.log(results.widgets[0].content); // Array of products
```

#### `getPriceAndStock(products)`

Fetches the current pricing and stock availability (including local NZ and AU
stock). Expects an array of objects containing `itemId` and `qty`.

```javascript
const items = [
  { itemId: "TPHS25R5GM", qty: 1 },
  { itemId: "1756BA1", qty: 5 },
];
const pricingData = await client.getPriceAndStock(items);

// Example response mapping:
for (const prod of pricingData.ChildProducts) {
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

## Environment Adapting (Node.js vs Deno)

This library uses a specialized internal `fs_adapter.js` file for all OS-level
file system and environment variable operations.

Currently, the adapter is configured for **Deno**.

If you want to migrate this codebase to **Node.js**:

1. Open `fs_adapter.js`.
2. Delete the lines reading `Deno.readTextFile` / `Deno.env.get`.
3. Uncomment the provided Node.js code snippets using `import("fs/promises")`
   and `process.env`.
4. Ensure you install a DOM parsing library (like `jsdom` or `cheerio`) to
   replace the `deno-dom-wasm` import found at the top of `api.js`.
