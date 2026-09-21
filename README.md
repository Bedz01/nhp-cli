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

`-A` grants the network and file access the tool needs: the portal, and its
state directory (see Setup). `deno task cli <args>` is a shorthand for the
same command. Deno fetches the dependencies on the first run, so that run
takes a moment longer.

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

Log in once:

```
nhp login
```

It asks for your portal username and password (the password is not echoed),
logs in, and remembers both so later commands - and the re-login needed when
the portal's 48-hour session expires - happen silently. Any command run
before that will ask the same questions itself if it is running in a
terminal.
`nhp login --reset` asks again (to change accounts); `nhp logout` forgets
the session and the saved credentials.

**Where things live.** All state goes in a per-user directory, never in the
checkout, so it survives re-clones and `git` never sees it:

| Platform | Directory |
| --- | --- |
| Windows | `%APPDATA%\nhp` |
| Linux / macOS | `$XDG_CONFIG_HOME/nhp`, else `~/.config/nhp` |
| Override | `NHP_CONFIG_DIR` |

```
config.json       { "sellMarginMultiplier": 1.25 }   optional; enables the Sell: line
credentials.json  saved by `nhp login`
cookies.json      the portal session
```

**How the password is stored.** On Windows it is encrypted with DPAPI in
the current-user scope, so the file can only be decrypted by your Windows
account on that machine; copying it elsewhere yields nothing. The CLI does
this through a short PowerShell script (`ProtectedData`, no cmdlets or
modules involved), tried in Windows PowerShell 5.1 and then `pwsh`, and only
when it actually needs to log in. If neither PowerShell works, the password
is stored as plain text and `nhp login` says so. On Linux and macOS the file
is plain text with mode `600`.

**Scripts and CI.** Environment variables override the stored file and never
prompt:

- `NHP_USERNAME`, `NHP_PASSWORD`
- `NHP_SELL_MARGIN` *(optional)*
- `NHP_CONFIG_DIR` *(optional)*

With `--json` or `--tsv`, or with no terminal, a missing login is an error
(`Run 'nhp login'`) rather than a prompt, so stdout stays clean.

**Upgrading from 1.3 or earlier.** The old `credentials.json` and
`cookies.json` next to `nhp_cli.js` are still read as a fallback. Run
`nhp login` once: it moves the credentials (and the margin) into the state
directory, after which the old files are no longer read and can be deleted.

### Commands

Run `nhp help` (or `nhp --help`) for the full built-in reference.

**Products & Pricing**

- `nhp search <query>` - Search for products matching a query.
- `nhp price <part>[:qty]... [--full|--tsv]` - Price and stock for one or
  more part numbers as a ledger, one line per part: `PART  DESCRIPTION  QTY
  BUY  [SELL]  STOCK` (description truncated to fit, `SELL` only when a
  margin is configured, stock as glyph + NZ on-hand quantity + state; an
  unknown part keeps its line with the portal's reason and `✗ NOT FOUND`).
  Quantities go on the part as `K144:2 06850863:10`; `--qty <n>` is the
  default for parts without one. A bare number is always a part number.
  Add `--full` for the record view with discount, AU stock and the rest.
- `nhp csv <csvFile> [--full|--tsv]` - The same for part numbers listed in a
  CSV file. Columns: `partNumber[,qty]` - a single-column file of part
  numbers also works (qty defaults to 1), and a header row is skipped
  automatically.

**Orders & Invoices**

- `nhp orders [page] [--full|--tsv]` - Get order history as a compact ledger
  (`ORDER  PO  STATUS  DATE`, one line per order), 20 per page starting at
  page 1. Add `--full` for the record view with totals. Optional search
  flags: `--dateFrom`, `--dateTo` (yyyy-mm-dd), and `--purchaseNumber`,
  `--documentNumber`, `--orderNumber`, `--customerReference` - the portal
  has a single free-text search box, so the latter four all feed the same
  match.
- `nhp invoices [page] [--brief|--tsv]` - Get invoice history. Accepts the same
  optional search flags as orders. Add `--brief` for the ledger view
  (`INVOICE  ORDER  PO  DATE` - the order column links each invoice to the
  sales order it came from).
- `nhp order <orderId...> [--full|--tsv]` - Line items for one or more orders
  (e.g. `SOR1314816`) as a ledger, one line per item: `PART  DESCRIPTION
  DLV/ORD  STATUS` (description truncated to fit, delivered/ordered quantity
  coloured green/yellow/red, the status carrying the portal's delivery
  estimate). Several order IDs print one ledger each, separated by a blank
  line and led by `Order | PO | Ref | Date`; an order that can't be fetched
  is reported on stderr without stopping the others, and the command still
  exits non-zero. With several IDs, `--json` emits an array with one entry
  per argument (a failure becoming `{ orderId, error }`); a single ID keeps
  the bare API response. Add `--full` for the record view with header,
  addresses, prices and totals.
- `nhp invoice <id> [--brief|--tsv]` - Get detailed line items for a specific
  invoice (e.g. `SIN02755715`). `--brief` prints `PART  DESCRIPTION  QTY`.
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
- `nhp cart upload <csvFilePath>` - Add a CSV of part numbers to the cart
  (same format as `nhp csv`). Parts the portal rejects are reported
  individually with its reason, and the command exits non-zero.

**Authentication**

- `nhp login [--reset]` - Log in and save the session. Asks for the username
  and password the first time (or with `--reset`) and remembers them;
  otherwise re-logs in with the saved ones. `--json` reports the username,
  where the credentials came from, and the file paths.
- `nhp logout` - Forget the saved session and credentials.

### Spreadsheet Export (`--tsv`)

`price`, `csv`, `orders`, `order`, `invoices`, `invoice` and `po` take
`--tsv`: one header row and one tab-separated row per record (per line item
for `order`/`invoice`, across every order given), with the order- or
invoice-level fields repeated on each row so the result is a flat table.
Plain text only - no colour, glyphs, truncation, or progress line; money and
quantities are bare numbers - so it pastes straight into columns:

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
is the undiscounted price from the part's price break and `CURRENCY` always
`NZD`; `SELL` is filled only when `sellMarginMultiplier` is configured;
`LINE` is the portal's own line number. Dates are `dd/mm/yyyy` as in every
other view. Failures behave as in the human view (stderr, non-zero exit) and
contribute no rows. `--tsv` wins over `--full`/`--brief`, `--json` wins over
both.

### JSON Output & Exit Codes

You can append `--json` to any command to receive the raw JSON response on
stdout instead of the formatted terminal output. Progress and error messages go
to stderr, so stdout stays valid JSON for piping:

```bash
nhp orders 1 --purchaseNumber PO-12345 --json > orders.json
```

Failed operations (unknown part numbers on `cart add`, items not found, API
errors) exit with a non-zero status code, so the CLI is safe to script against.

### Portal Quirks

The portal was rebuilt in September 2026 (Next.js over a REST API at
`/api/v1/`); these are the undocumented behaviours of the new backend:

- **Login is Microsoft Entra native auth, proxied through the portal.** The
  flow is preflight → initiate → challenge → token against
  `/api/v1/auth/oauth2/v2.0/*`; the token response sets the `__Host-sid`
  session cookie (48 h), and that cookie alone authenticates every data
  call - there are no anti-forgery tokens and the OAuth tokens themselves
  are never needed. If the challenge step asks for anything but `password`
  (e.g. an emailed code), the CLI cannot answer it and says so.
- **The order-detail endpoint rejects the order list's own ids.**
  `GET /orders/{id}` wants the bare sales order number (`SOR1314816`); the
  composite `id` the list returns (`NZ-20198-SOR1314816`) gets a 404. The
  client strips the prefix (`normalizeOrderId`). Invoices are the same
  story: `GET /invoices/{id}/line-items` wants the invoice number
  (`SIN02755715`), not the GUID `id` field from the invoice list.
- **Line items carry two prices.** `unitPrice` is the list price;
  `netPrice` is the account's actual price, and `lineAmount` is
  `netPrice × qty`. Everything printed as a price uses `netPrice`.
- **Invoice `status` is a bare code** (every invoice so far says `"3"`); the
  portal itself does not display it anywhere, so this tool doesn't either.
  The invoice ledger shows the related order number in that column instead,
  the `--tsv` STATUS cell stays blank, and `--json` still carries the raw
  code.
- **Batch endpoints cap at 20 ids per request** (`products/batch`,
  `availability`, `cart/lineitems/batch`); the client chunks transparently.
- **There is no clear-cart endpoint.** The site's own "Remove all" deletes
  lines one at a time; `cart clear` does the same.
- **Dates are ISO timestamps**, except line statuses, which embed unpadded
  `d/M/yyyy` inside text like `Est. Delivery: 22/09/2026`. Every printed
  date goes through `formatDate`, which normalises both to `dd/mm/yyyy`.

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

Create a new instance of the client. By default it resolves credentials the
way the CLI does (environment variables, then the file `nhp login` saved)
and keeps the session in the same state directory (see Setup).

```javascript
const client = new NHPClient({
  // Optional configuration overrides:
  cookiePath: "./data/custom_cookies.json",
  credentials: {
    username: "your_email@example.com",
    password: "your_password",
  },
  timeoutMs: 30000, // Per-request timeout (default 30s)
  silent: true, // Set to true to suppress internal console log messages
});

// Always call ensureLogin() before making API calls
await client.ensureLogin();
```

`credentials` may also be an async function; it is called only when a login
is actually needed, so an expensive lookup (a keychain, a prompt) does not
run on every command. `onLogin(creds)` is called after each successful
login. The `store` export has the pieces the CLI uses: `resolveCredentials`,
`saveCredentials`, `dpapiProtect`/`dpapiUnprotect`, `configDir`.

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

Fetches product records and stock availability in parallel and stitches them
per requested item. Expects an array of objects containing `itemId` (the part
number) and `qty`. An unknown part keeps its entry with `error` set instead
of throwing, so results always line up with the request.

```javascript
const items = [
  { itemId: "TPHS25R5GM", qty: 1 },
  { itemId: "1756BA1", qty: 5 },
];
const pricing = await client.getPriceAndStock(items);

for (const entry of pricing.products) {
  if (entry.error) continue; // Unknown part - the portal's reason is in entry.error
  const brk = entry.product.priceBreaks[0];
  console.log(`Buy: ${brk.discountedPrice}  List: ${brk.price}`);
  const nz = entry.availability.stockQuantities.find((s) => s.type === "national");
  console.log(`NZ Stock: ${nz?.quantity ?? 0}`);
}
```

`getProducts(itemIds)` and `getAvailability(itemIds)` expose the two halves
individually.

#### `getOrders(pageSize, page, options)`

Fetches the user's order history (pages are 1-based). Responses are
`{ items, meta }` with `meta` carrying `page`, `totalPages` and `totalCount`.
The `options` object takes `dateFrom`/`dateTo` (yyyy-mm-dd) and a free-text
`search` (`purchaseNumber`, `documentNumber`, `orderNumber` and
`customerReference` are accepted as aliases - the portal has one search box).

```javascript
// Get the first 20 orders
const orders = await client.getOrders(20, 1);

// Search for a specific Purchase Order number and date range
const poOrders = await client.getOrders(20, 1, {
  purchaseNumber: "PO-12345",
  dateFrom: "2025-12-01",
  dateTo: "2025-12-06",
});
```

#### `getInvoices(pageSize, page, options)`

Fetches the user's invoice history. The `options` object accepts the same
search filters as `getOrders`. `getBackorders(pageSize, page)` lists open
backorder lines the same way.

```javascript
const invoices = await client.getInvoices(20, 1, { dateFrom: "2026-01-01" });
```

#### `getOrderDetails(orderId)`

Fetches the order header and line items (with shipping status and delivery
estimates) for a sales order number. The composite ids the order list
returns are accepted and normalised.

```javascript
const details = await client.getOrderDetails("SOR1314816");
console.log(details.lineItems);
```

#### `getInvoiceDetails(invoiceId)`

Fetches `{ header, lineItems }` for an invoice number.

```javascript
const { header, lineItems } = await client.getInvoiceDetails("SIN02755715");
```

#### Cart Management

The library provides complete functionality to manage the user's shopping
cart. Mutations respond with the updated cart state.

```javascript
await client.addToCart("115797", 2);
const cart = await client.getCart(); // { cart, lineItems, miniCart, messages }
await client.updateCartLineQuantity(cart.lineItems[0], 5);
await client.removeCartLine(cart.lineItems[0].id);
await client.clearCart();

// Bulk adds report per-item outcomes:
const result = await client.uploadCartCsv("./bulk_order.csv");
// -> { success: boolean, requested: string[], missing: string[], Warnings: string[] }
```

## Development

```bash
deno task check   # lint + type-check + tests
deno task test    # offline unit tests only
```

Offline unit tests live in `tests/` and run in CI on every push.
