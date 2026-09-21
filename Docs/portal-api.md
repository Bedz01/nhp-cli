# NHP portal API (post-2026 redesign)

The portal at `www.nhpnz.co.nz` is a Next.js (App Router, Vercel-hosted)
frontend over a first-party REST API under `/api/v1/`. All endpoints are
same-origin and authenticate with the `__Host-sid` session cookie alone -
no bearer tokens on data calls, no anti-forgery tokens anywhere.

This map was extracted from the site's client bundles and verified against
live traffic (HAR capture + direct probing, September 2026). `api.js`
implements the subset the CLI uses.

## Authentication (verified live)

Login is Microsoft Entra External ID **native auth** (MSAL custom-auth flow),
proxied through the site's own origin so the client never talks to Microsoft
directly:

- Public client id: `bf3a79f2-3e70-4b13-9945-481ba2f6c678` (in the public JS)
- Auth proxy base: `https://www.nhpnz.co.nz/api/v1/auth`

Flow (all bodies form-encoded unless noted; no MSAL telemetry headers are
required):

1. `POST /api/v1/session/preflight` — JSON `{ identifier: <username> }` →
   `{ requiresReset, accountDisabled }`.
2. `POST /api/v1/auth/oauth2/v2.0/initiate` —
   `client_id`, `username`, `challenge_type=password oob redirect` →
   `{ continuation_token }`.
3. `POST /api/v1/auth/oauth2/v2.0/challenge` —
   `client_id`, `continuation_token`, `challenge_type` →
   `{ challenge_type: "password", continuation_token }`. Anything but
   `password` here (e.g. `oob`, an emailed code) cannot be answered
   headlessly.
4. `POST /api/v1/auth/oauth2/v2.0/token` —
   `client_id`, `continuation_token`, `grant_type=password`,
   `scope=openid profile offline_access`, `password`, `client_info=true` →
   OAuth tokens **and** a `Set-Cookie: __Host-sid=...` (Max-Age 172800 =
   48 h). The cookie is the session; the tokens are never needed again.

`GET /api/v1/session` → `{ isAuthenticated, user: { buyer, username, ... } }`
introspects the session. `POST /api/v1/session/renew` renews it.
`POST /api/v1/auth/logout` ends it. A stale/garbage `__Host-sid` gets a 401
from data endpoints, which the client answers with one re-login + retry.

There is also `POST /api/v1/auth/session-handoff` (used by the site after a
password reset) — not needed for the plain login path.

## Data endpoints (verified unless noted)

All JSON over the session cookie.

### Products / pricing

| Endpoint | Method | Shape |
|---|---|---|
| `/api/v1/commerce/products/{id}` | GET | single product; id is the upper-cased part number |
| `/api/v1/commerce/products/batch` | POST | `{ productIds: [...] }` → `{ requestedProductIds, products, errors: [{ productId, status, message }] }`; max 20 ids |
| `/api/v1/commerce/products/availability` | POST | `{ products: [{ id }], locale: "NZ" }` → `{ items: [{ productId, stockQuantities, blockAddToCart }] }` |
| `/api/v1/commerce/products/atp` | POST | available-to-promise dates, `[{ id, quantity }]`-style *(unverified)* |
| `/api/v1/search` | POST | Sitecore Search; same widget body as the pre-redesign `xmc-next` endpoint, same response (`widgets[0].content` with `sku`, `name`, `brand`, `product_url`) |

Pricing lives in `product.priceBreaks`: `[{ price, quantity, salePrice,
discountedPrice }]` — `price` is list, `discountedPrice` is the account's
buy price, quantity-tiered. Stock: `stockQuantities` entries are
`{ quantity, location, type }` with `type: "national"` = NZ and the
`warehouse` entries = AU.

### Orders / invoices

| Endpoint | Method | Shape |
|---|---|---|
| `/api/v1/commerce/orders/all` | GET | `page` (1-based), `pageSize`, `sortBy` (`!DateCreated` = desc), `search`, `from`, `to` → `{ items, meta: { page, totalPages, totalCount, hasNextPage } }` |
| `/api/v1/commerce/orders/{salesId}` | GET | header fields flattened on the object + `lineItems`. **Wants the bare `SOR...` number; the list's composite id (`NZ-20198-SOR...`) 404s** |
| `/api/v1/commerce/orders/backorders` | GET | same paging; `sortBy=OrderNumber` |
| `/api/v1/commerce/invoices/all` | GET | same paging; `sortBy=!InvoiceDate` |
| `/api/v1/commerce/invoices/{invoiceId}/line-items` | GET | `{ header, lineItems }`. **Wants the `SIN...` number, not the list's GUID `id`** |
| `/api/v1/commerce/credit-notes/all`, `quotes`, `order-templates` | GET | present, unused by the CLI |

`search` is one free-text box (matches order no / PO / reference). Line
items: `unitPrice` = list, `netPrice` = account price, `lineAmount` =
`netPrice × qty`; order lines add `remainingQty`, `eta`
(`"Est. Delivery: d/M/yyyy"`), `isBackOrder`, `lineNo`. Order `status` is an
enum (`ORDER_RECEIVED`, `IN_PROGRESS`, `ON_HOLD`, `COMPLETED`, `CANCELLED`);
invoice `status` is an opaque code (always `"3"` so far) the portal never
displays. On invoices the PO lives in `customerRequisition`.

### Cart

| Endpoint | Method | Shape |
|---|---|---|
| `/api/v1/commerce/cart` | GET | `{ cart, lineItems, miniCart, messages }` |
| `/api/v1/commerce/cart/lineitems` | POST | `{ productID, quantity }` → the updated cart |
| `/api/v1/commerce/cart/lineitems/batch` | POST | `{ items: [{ productID, quantity }] }` → `{ applied, errors: [{ productID, message }] }`; max 20 |
| `/api/v1/commerce/cart/lineitems/{lineId}` | PATCH | `{ productID, quantity, inventoryRecordId }` |
| `/api/v1/commerce/cart/lineitems/{lineId}` | DELETE | empty body → the updated cart |
| `/api/v1/commerce/import-file/products` | POST | multipart `file`; parses a spreadsheet into rows client-side. The CLI uses `lineitems/batch` instead |

There is no clear-cart endpoint; the site's own "Remove all" deletes lines
one at a time.

**Never call:** `/api/v1/commerce/cart/submit`,
`/api/v1/commerce/checkout-order`, `/api/v1/commerce/checkout-activity` -
order placement is out of bounds for this tool.

## What changed from the old portal

The previous Sitecore CXA implementation is gone entirely: no
`__RequestVerificationToken` / `_CRSFform`, no `api/cxa/*` endpoints, no
`.AspNet.Cookies`, no 420 responses for stale tokens. Forms-auth login, the
anti-forgery dance, and all HTML scraping (order/invoice pages, the CSV cart
upload form) are obsolete — everything is JSON now, and detail pages that
used to be scraped are server-rendered but backed by the endpoints above.
The portal is also dramatically faster: responses that took 60s+ now take
under a second, so the client's default timeout dropped from 120s to 30s.
