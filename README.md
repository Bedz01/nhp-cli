# NHPProxy CLI & Library

This package provides a CLI and an API Library to integrate with NHP New
Zealand. You can search products, check pricing, check stock availability,
manage your cart, and pull order/invoice history.

> [!NOTE]
> This tool is currently configured for NHP New Zealand (`nhpnz.co.nz`).
> However, it should also work on the Australian version of the site
> (`nhp.com.au`) with some minor domain and configuration tweaks.

## CLI Usage

### Requirements

- [Deno](https://deno.com/) 2.x. Install it with the official one-liner, then
  check `deno --version`:

  ```powershell
  irm https://deno.land/install.ps1 | iex            # Windows (PowerShell)
  ```
  ```bash
  curl -fsSL https://deno.land/install.sh | sh       # macOS / Linux
  ```

- Git, to clone this repository.
- A login for the NHP New Zealand web portal (`nhpnz.co.nz`).

### Install

Clone the repository and run the CLI from inside it:

```bash
git clone https://github.com/Bedz01/nhp-cli.git
cd nhp-cli
deno run -A nhp_cli.js help
```

`-A` grants the network and file access the tool needs: the portal, and the
`credentials.json` / `cookies.json` files it keeps next to `nhp_cli.js`.
`deno task cli <args>` is a shorthand for the same command. Deno fetches the
dependencies on the first run, so that run takes a moment longer.

To run it as `nhp` from any directory, install it globally:

```bash
deno install -g -A -f -n nhp nhp_cli.js
```

Deno puts the `nhp` shim in its bin directory (`~/.deno/bin`, or
`%USERPROFILE%\.deno\bin` on Windows) and tells you if that directory is not
on your `PATH` yet. All dependencies are referenced with explicit versioned
specifiers, so the installed command works from any directory without extra
flags. Re-run the install command after pulling changes.

### Setup

Before running the CLI, you must configure your NHP login details. You can do
this in one of two ways:

**Option 1: credentials.json** Create a `credentials.json` file next to
`nhp_cli.js` (the repository root):

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

- `nhp orders [offset] [--full|--tsv]` - Get order history as a compact ledger
  (`ORDER  PO  STATUS  DATE`, one line per order). Add `--full` for the
  record view with totals. Optional search flags: `--dateFrom`, `--dateTo`,
  `--purchaseNumber`, `--documentNumber`, `--orderNumber`,
  `--customerReference`.
- `nhp invoices [offset] [--brief|--tsv]` - Get invoice history. Accepts the same
  optional search flags as orders. Add `--brief` for the ledger view.
- `nhp order <orderId...> [--full|--tsv]` - Line items for one or more orders as a
  ledger, one line per item: `PART  DESCRIPTION  DLV/ORD  STATUS`
  (description truncated to fit, delivered/ordered quantity coloured
  green/yellow/red). Several order IDs are fetched one at a time (each is a
  full page scrape) and print one ledger each, separated by a blank line and
  led by `Order | PO | Ref | Date`; an order that can't be fetched is reported
  on stderr without stopping the others, and the command still exits non-zero.
  With several IDs, `--json` emits an array with one entry per argument (a
  failure becoming `{ orderId, error }`); a single ID keeps the bare scrape
  result. Add `--full` for the record view with header, addresses, prices and
  totals.
- `nhp invoice <id> [--brief|--tsv]` - Get detailed line items for a specific invoice.
  `--brief` prints `PART  DESCRIPTION  QTY`.
- `nhp po <query>` - Search order history by PO Number. A single match
  auto-expands like `nhp order` (ledger, or record view with `--full`).

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

### Spreadsheet Export (`--tsv`)

`price`, `csv`, `orders`, `order`, `invoices`, `invoice` and `po` take
`--tsv`: one header row and one tab-separated row per record (per line item
for `order`/`invoice`, across every order given), with the order- or
invoice-level fields repeated on each row so the result is a flat table.
Plain text only - no colour, glyphs, truncation, or progress line; money and
quantities are bare numbers parsed out of the portal's `$1,234.56` strings -
so it pastes straight into columns:

```powershell
nhp order SOR1000001 SOR1000002 --tsv | Set-Clipboard        # then paste into Excel/Sheets
nhp invoices --dateFrom 2026-07-01 --tsv | Set-Clipboard
nhp price K144 06850863 --tsv | ConvertFrom-Csv -Delimiter "`t"   # PowerShell objects
```

Columns (blank where NHP has no such value):

```
price/csv   PART  DESCRIPTION  QTY  BUY  SELL  LIST  CURRENCY  STOCK  STOCK STATUS  ERROR
orders      ORDER  PO  STATUS  DATE  TOTAL
order       ORDER  PO  ORDER STATUS  DATE  LINE  PART  DESCRIPTION  DELIVERED  ORDERED  LINE STATUS  UNIT PRICE  TOTAL
invoices    INVOICE  PO  REF  STATUS  DATE  TOTAL  OUTSTANDING
invoice     INVOICE  PO  REF  DATE  LINE  PART  DESCRIPTION  QTY  UNIT PRICE  TOTAL
```

`STOCK` is the NZ on-hand quantity and `STOCK STATUS` the badge text; `LIST`
is always blank (the portal has no list price) and `CURRENCY` always `NZD`;
`SELL` is filled only when `sellMarginMultiplier` is configured; `LINE` is the
1-based position (the portal has no line numbers). Dates are `dd/mm/yyyy` as
in every other view. Failures behave as in the human view (stderr, non-zero
exit) and contribute no rows. `--tsv` wins over `--full`/`--brief`, `--json`
wins over both.

### JSON Output & Exit Codes

You can append `--json` to any command to receive the raw JSON response on
stdout instead of the formatted terminal output. Progress and error messages go
to stderr, so stdout stays valid JSON for piping:

```bash
nhp orders 0 --purchaseNumber PO-12345 --json > orders.json
```

Failed operations (unknown part numbers on `cart add`, items not found, API
errors) exit with a non-zero status code, so the CLI is safe to script against.

### Portal Quirks

- **Header labels differ between the order and invoice pages, including
  capitalisation.** The order page says `Order Created on` and `Customer
  Reference no`; the invoice page says `Invoice date` (lower-case d) and the
  same `Customer Reference no`. The ledger summary line and the `--tsv`
  exports look the labels up through one shared fallback list in
  `formatters.js`; add new spellings there, not at the call sites.
- **Portal dates are unpadded `d/M/yyyy`** (`3/09/2026`, day first). Every
  printed date goes through `formatDate`, which zero-pads to `dd/mm/yyyy`.

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
