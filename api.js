import { CookieJar } from "./cookie-jar.js";
import { parseCsvText } from "./config.js";
import { configPath, ensureConfigDir, fileExists, legacyPath, resolveCredentials, SESSION_FILE } from "./store.js";
import { Logger } from "./logger.js";

// The portal (rebuilt 09/2026) is a Next.js frontend over a same-origin REST
// API at /api/v1/. Everything authenticates with the __Host-sid session
// cookie; there are no anti-forgery tokens. See Docs/portal-api.md.
const BASE = "https://www.nhpnz.co.nz";
// Public MSAL client id, from the site's own bundles. Login is Microsoft
// Entra native auth proxied through the portal's /api/v1/auth endpoint.
const CLIENT_ID = "bf3a79f2-3e70-4b13-9945-481ba2f6c678";
const SESSION_COOKIE = "__Host-sid";

export class NHPAPIError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = "NHPAPIError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

// The portal caps id lists at 20 per request in its own UI code.
const BATCH_SIZE = 20;

// The order-detail endpoint takes the bare sales order number ("SOR1314816");
// the order list's composite id ("NZ-20198-SOR1314816") is rejected with a
// 404, so a composite id is reduced to its final segment here.
export function normalizeOrderId(orderId) {
  return String(orderId).toUpperCase().replace(/^[A-Z]+-\d+-/, "");
}

// An order's line items as cart-addable { itemId, qty } entries. Deleted and
// zero-quantity lines (cancelled / not yet confirmed) are skipped, and
// repeated parts are merged into one entry.
export function orderCartItems(lineItems) {
  const byId = new Map();
  for (const l of lineItems || []) {
    if (l.isdeleted || !l.itemId || !((l.qty ?? 0) > 0)) continue;
    const id = String(l.itemId).toUpperCase();
    byId.set(id, { itemId: id, qty: (byId.get(id)?.qty ?? 0) + l.qty });
  }
  return [...byId.values()];
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class NHPClient {
  constructor(config = {}) {
    this.jar = new CookieJar();
    // Session cache: the per-user config dir (store.js) unless a path is given.
    this.cookiePath = config.cookiePath || null;
    // Static { username, password }, or an async provider called only when a
    // login is actually needed (the CLI uses one so a stored password is
    // decrypted, or prompted for, no more often than that).
    this.credentials = config.credentials || null;
    // Called with the credentials after each successful login.
    this.onLogin = config.onLogin || null;
    this.loggedInAt = null;
    this.userAgent = config.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    this.timeoutMs = config.timeoutMs || 30000;
    this.logger = config.logger || new Logger({ isJson: config.silent, verbose: false });
    this._isSessionVerified = false;
    this._authPromise = null;
  }

  async init() {
    if (!this.cookiePath) {
      await ensureConfigDir();
      this.cookiePath = configPath(SESSION_FILE);
      // Upgrade path: a session saved by an older version next to the module.
      // It is loaded once and lands in the config dir on the next save.
      if (!(await fileExists(this.cookiePath)) && (await fileExists(legacyPath(SESSION_FILE)))) {
        await this.jar.loadFromFile(legacyPath(SESSION_FILE));
        return;
      }
    }
    await this.jar.loadFromFile(this.cookiePath);
  }

  // Base fetch: applies user agent, cookies, and a timeout, then accepts and
  // persists any cookies from the response.
  async _fetch(url, init = {}) {
    const headers = {
      "User-Agent": this.userAgent,
      "Accept-Language": "en-US,en;q=0.9",
      ...init.headers,
    };
    const cookieHeader = this.jar.getCookieHeader();
    if (cookieHeader && !("Cookie" in headers)) {
      headers["Cookie"] = cookieHeader;
    }

    let response;
    try {
      response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (err.name === "TimeoutError") {
        throw new NHPAPIError(`Request timed out after ${this.timeoutMs / 1000}s: ${url}`, 408, "");
      }
      throw err;
    }

    this.jar.acceptCookies(response.headers);
    await this.jar.saveToFile(this.cookiePath);
    return response;
  }

  // A JSON request against /api/v1/. `json` and `form` are exclusive bodies;
  // `query` is appended to the path. Throws NHPAPIError with the backend's
  // own reason where it gives one ({ error } / { message } / RFC 9457 title).
  async _api(label, method, path, { json, form, query, headers } = {}) {
    let url = BASE + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (path.includes("?") ? "&" : "?") + qs;
    }

    const init = {
      method,
      headers: { "Accept": "application/json, text/plain, */*", "Referer": BASE + "/", ...headers },
    };
    if (json !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }

    const response = await this._fetch(url, init);
    const responseText = await response.text();
    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch {
      // Some endpoints 404 with an HTML error page; data stays null.
    }

    if (!response.ok) {
      const reason = data?.error_description?.split(/\r?\n/)[0] || data?.error || data?.message || data?.title ||
        `${label} API returned status ${response.status}`;
      throw new NHPAPIError(typeof reason === "string" ? reason : `${label} API returned status ${response.status}`, response.status, responseText);
    }
    if (data === null && responseText.trim() !== "") {
      throw new NHPAPIError(`[${label} API] Failed to parse response JSON. Response starts with: ${responseText.substring(0, 100)}`, response.status, responseText);
    }
    return data;
  }

  async verifySession() {
    if (!this.jar.has(SESSION_COOKIE)) return false;
    try {
      const session = await this._api("Session", "GET", "/api/v1/session");
      return session?.isAuthenticated === true;
    } catch {
      return false;
    }
  }

  async ensureLogin(force = false) {
    if (this._authPromise) {
      await this._authPromise;
      return;
    }

    this._authPromise = (async () => {
      await this.init();
      if (!force) {
        if (this._isSessionVerified) return;
        // Reuse a saved session cookie optimistically; if it turns out to be
        // stale, _withAuthRetry re-authenticates and retries the request.
        if (this.jar.has(SESSION_COOKIE)) {
          this.logger.debug(`[Auth] Reusing saved session cookie.`);
          this._isSessionVerified = true;
          return;
        }
        this.logger.debug(`[Auth] No saved session cookie. Performing login...`);
      } else {
        this.logger.debug(`[Auth] Force login requested. Logging in...`);
      }

      await this.performLogin();
      this._isSessionVerified = true;
    })();

    try {
      await this._authPromise;
    } finally {
      this._authPromise = null;
    }
  }

  // One step of the Entra native-auth flow (initiate/challenge/token),
  // proxied through the portal. Errors carry Entra's error_description.
  _authStep(step, form) {
    return this._api(`Login (${step})`, "POST", `/api/v1/auth/oauth2/v2.0/${step}`, { form });
  }

  // Login: Microsoft Entra External ID native auth, proxied by the portal.
  //   1. POST /api/v1/session/preflight   account state ({ requiresReset })
  //   2. POST .../oauth2/v2.0/initiate    username -> continuation_token
  //   3. POST .../oauth2/v2.0/challenge   expect challenge_type "password"
  //   4. POST .../oauth2/v2.0/token       password -> tokens; the proxy sets
  //      the __Host-sid session cookie (48h) on this response, and that
  //      cookie alone authenticates every data endpoint afterwards.
  async performLogin() {
    this.jar.clear();
    const creds = typeof this.credentials === "function"
      ? await this.credentials()
      : (this.credentials || await resolveCredentials());
    if (!creds) throw new NHPAPIError("No credentials. Run 'nhp login', or set NHP_USERNAME and NHP_PASSWORD.", 401, "");

    this.logger.debug(`[1/4] Preflight check for ${creds.username}...`);
    const preflight = await this._api("Login (preflight)", "POST", "/api/v1/session/preflight", { json: { identifier: creds.username } });
    if (preflight?.requiresReset) {
      throw new NHPAPIError("NHP requires a password reset for this account. Reset it on www.nhpnz.co.nz, then run 'nhp login --reset'.", 401, "");
    }
    if (preflight?.accountDisabled) {
      throw new NHPAPIError("This NHP account is disabled. Contact NHP.", 401, "");
    }

    this.logger.debug(`[2/4] Initiating sign-in...`);
    const initiate = await this._authStep("initiate", {
      client_id: CLIENT_ID,
      username: creds.username,
      challenge_type: "password oob redirect",
    });
    if (!initiate?.continuation_token) {
      throw new NHPAPIError("Login initiate returned no continuation token.", 500, JSON.stringify(initiate));
    }

    this.logger.debug(`[3/4] Requesting password challenge...`);
    const challenge = await this._authStep("challenge", {
      client_id: CLIENT_ID,
      continuation_token: initiate.continuation_token,
      challenge_type: "password oob redirect",
    });
    if (challenge?.challenge_type !== "password") {
      throw new NHPAPIError(`NHP asked for a '${challenge?.challenge_type}' challenge (e.g. an emailed code), which this tool cannot answer. Log in once at www.nhpnz.co.nz and try again.`, 401, JSON.stringify(challenge));
    }

    this.logger.debug(`[4/4] Submitting password...`);
    await this._authStep("token", {
      client_id: CLIENT_ID,
      continuation_token: challenge.continuation_token,
      grant_type: "password",
      scope: "openid profile offline_access",
      password: creds.password,
      client_info: "true",
    });

    if (!this.jar.has(SESSION_COOKIE)) {
      throw new NHPAPIError("Login succeeded but no session cookie was set.", 500, "");
    }

    this.loggedInAt = Date.now();
    this.logger.debug(`[Auth] Login successful. Session cookie saved.`);
    if (this.onLogin) await this.onLogin(creds);
  }

  async _withAuthRetry(fn) {
    await this.ensureLogin();
    try {
      return await fn();
    } catch (err) {
      const isAuthError = err instanceof NHPAPIError && (err.statusCode === 401 || err.statusCode === 403);
      if (isAuthError) {
        this.logger.debug(`[Auth] API call failed with suspected auth error. Retrying login once...`);
        this._isSessionVerified = false;
        await this.ensureLogin(true);
        return await fn();
      }
      throw err;
    }
  }

  // Site search (Sitecore Search; same widget request the site itself sends).
  searchProducts(query) {
    return this._withAuthRetry(() =>
      this._api("Search", "POST", "/api/v1/search", {
        json: {
          "widget": {
            "items": [{
              "rfk_id": "rfkid_6",
              "entity": "product",
              "search": { "content": {}, "limit": 10, "query": { "keyphrase": query }, "suggestion": [{ "max": 10, "name": "product_name_did_you_mean", "keyphrase_fallback": true }] },
            }],
          },
          "context": { "locale": { "country": "nz", "language": "en" }, "user": { "user_id": crypto.randomUUID() } },
        },
      })
    );
  }

  // Product records (pricing lives in priceBreaks). Unknown parts come back
  // in `errors` with the backend's reason, never as a throw.
  getProducts(itemIds) {
    return this._withAuthRetry(async () => {
      const merged = { products: [], errors: [] };
      for (const ids of chunk(itemIds, BATCH_SIZE)) {
        const result = await this._api("Products", "POST", "/api/v1/commerce/products/batch", { json: { productIds: ids } });
        merged.products.push(...(result?.products || []));
        merged.errors.push(...(result?.errors || []));
      }
      return merged;
    });
  }

  // Stock for a list of part numbers.
  getAvailability(itemIds) {
    return this._withAuthRetry(async () => {
      const items = [];
      for (const ids of chunk(itemIds, BATCH_SIZE)) {
        const result = await this._api("Availability", "POST", "/api/v1/commerce/products/availability", {
          json: { products: ids.map((id) => ({ id })), locale: "NZ" },
        });
        items.push(...(result?.items || []));
      }
      return { items };
    });
  }

  // Price and stock for { itemId, qty } items: product records (prices) and
  // availability (stock) fetched in parallel and stitched per requested item.
  // A part the portal does not recognise keeps its entry with `error` set, so
  // rows always line up with the request.
  async getPriceAndStock(items) {
    const ids = items.map((p) => String(p.itemId).toUpperCase());
    const [products, availability] = await Promise.all([this.getProducts(ids), this.getAvailability(ids)]);

    const byId = new Map(products.products.map((p) => [p.id.toUpperCase(), p]));
    const stockById = new Map((availability.items || []).map((a) => [a.productId.toUpperCase(), a]));
    const errorById = new Map(products.errors.map((e) => [String(e.productId).toUpperCase(), e.message || `Status ${e.status}`]));

    return {
      products: items.map((item) => {
        const id = String(item.itemId).toUpperCase();
        return {
          itemId: id,
          qty: item.qty,
          product: byId.get(id) ?? null,
          availability: stockById.get(id) ?? null,
          error: byId.has(id) ? null : (errorById.get(id) ?? "Item not recognised."),
        };
      }),
    };
  }

  _history(label, path, sortBy, page, pageSize, options = {}) {
    return this._withAuthRetry(() =>
      this._api(label, "GET", path, {
        query: {
          page,
          pageSize,
          sortBy,
          // One free-text `search` box matches document/order/PO/reference
          // numbers; the old per-field filters all funnel into it.
          search: options.search || options.purchaseNumber || options.documentNumber || options.orderNumber || options.customerReference,
          from: options.dateFrom,
          to: options.dateTo,
        },
      })
    );
  }

  getOrders(pageSize = 20, page = 1, options = {}) {
    return this._history("Orders", "/api/v1/commerce/orders/all", "!DateCreated", page, pageSize, options);
  }

  getInvoices(pageSize = 20, page = 1, options = {}) {
    return this._history("Invoices", "/api/v1/commerce/invoices/all", "!InvoiceDate", page, pageSize, options);
  }

  getBackorders(pageSize = 20, page = 1, options = {}) {
    return this._history("Backorders", "/api/v1/commerce/orders/backorders", "OrderNumber", page, pageSize, options);
  }

  getOrderDetails(orderId) {
    const id = normalizeOrderId(orderId);
    return this._withAuthRetry(() => this._api("Order", "GET", `/api/v1/commerce/orders/${encodeURIComponent(id)}`));
  }

  // Invoice details take the invoice number ("SIN02755715"); the invoice
  // list's GUID `id` is not accepted. Returns { header, lineItems }.
  getInvoiceDetails(invoiceId) {
    const id = String(invoiceId).toUpperCase();
    return this._withAuthRetry(() => this._api("Invoice", "GET", `/api/v1/commerce/invoices/${encodeURIComponent(id)}/line-items`));
  }

  getCart() {
    return this._withAuthRetry(() => this._api("Cart", "GET", "/api/v1/commerce/cart"));
  }

  addToCart(productId, quantity = 1) {
    return this._withAuthRetry(() =>
      this._api("Cart Add", "POST", "/api/v1/commerce/cart/lineitems", {
        json: { productID: String(productId).toUpperCase(), quantity },
      })
    );
  }

  // Bulk add. The endpoint reports per-item outcomes honestly:
  // { applied: [{ productID, ... }], errors: [{ productID, message }] }.
  addToCartBatch(items) {
    return this._withAuthRetry(async () => {
      const merged = { applied: [], errors: [] };
      for (const part of chunk(items, BATCH_SIZE)) {
        const result = await this._api("Cart Batch Add", "POST", "/api/v1/commerce/cart/lineitems/batch", {
          json: { items: part.map((i) => ({ productID: String(i.itemId ?? i.productID).toUpperCase(), quantity: i.qty ?? i.quantity ?? 1 })) },
        });
        merged.applied.push(...(result?.applied || []));
        merged.errors.push(...(result?.errors || []));
      }
      return merged;
    });
  }

  // Re-adds a previous order's lines to the cart. Returns the attempted
  // items plus the batch outcome: { orderId, items, applied, errors }.
  async addOrderToCart(orderId) {
    const details = await this.getOrderDetails(orderId);
    const items = orderCartItems(details?.lineItems);
    if (items.length === 0) return { orderId: normalizeOrderId(orderId), items, applied: [], errors: [] };
    const result = await this.addToCartBatch(items);
    return { orderId: normalizeOrderId(orderId), items, ...result };
  }

  // `line` is a line item from getCart(); PATCH wants the product and
  // inventory record echoed alongside the new quantity.
  updateCartLineQuantity(line, quantity) {
    return this._withAuthRetry(() =>
      this._api("Cart Update", "PATCH", `/api/v1/commerce/cart/lineitems/${encodeURIComponent(line.id)}`, {
        json: { productID: line.productID, quantity, inventoryRecordId: line.inventoryRecordId },
      })
    );
  }

  removeCartLine(lineId) {
    return this._withAuthRetry(() =>
      this._api("Cart Remove", "DELETE", `/api/v1/commerce/cart/lineitems/${encodeURIComponent(lineId)}`)
    );
  }

  // There is no single clear endpoint in the new API (the site's own "Remove
  // all" deletes lines one by one); do the same.
  async clearCart() {
    const cart = await this.getCart();
    const lines = cart?.lineItems || [];
    for (const line of lines) {
      await this.removeCartLine(line.id);
    }
    return { cleared: lines.length };
  }

  // CSV upload, rebuilt on the batch-add endpoint (the old HTML upload form
  // is gone). Returns the same { success, requested, missing, Warnings }
  // contract the CLI always had; `missing` lists part numbers the portal
  // rejected, with its reasons in Warnings.
  async uploadCartCsvContent(csvData) {
    const requested = parseCsvText(csvData);
    const result = await this.addToCartBatch(requested);
    const requestedIds = requested.map((p) => String(p.itemId).toUpperCase());
    const missing = (result.errors || []).map((e) => String(e.productID).toUpperCase());
    const warnings = (result.errors || []).map((e) => `${e.productID}: ${e.message}`);
    return { success: missing.length === 0, requested: requestedIds, missing, Warnings: warnings };
  }

  async uploadCartCsv(csvFilePath) {
    const csvData = await Deno.readTextFile(csvFilePath);
    return await this.uploadCartCsvContent(csvData);
  }
}
