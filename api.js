import { DOMParser } from "deno_dom";
import { CookieJar } from "./cookie-jar.js";
import { loadCredentials, parseCsvText } from "./config.js";
import { Logger } from "./logger.js";

export class NHPAPIError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = "NHPAPIError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

function extractToken(html) {
  const document = new DOMParser().parseFromString(html, "text/html");
  if (!document) {
    throw new NHPAPIError("Failed to parse HTML document while extracting token.", 500, html);
  }

  const crsfForm = document.querySelector('[id="_CRSFform" i]') || document.getElementById("_CRSFform");
  if (crsfForm) {
    const input = crsfForm.querySelector('input');
    if (input && input.getAttribute('value')) return input.getAttribute('value');
  }

  const globalInput = document.querySelector('input[name="__RequestVerificationToken" i]');
  if (globalInput && globalInput.getAttribute('value')) return globalInput.getAttribute('value');

  throw new NHPAPIError("Could not find __RequestVerificationToken in HTML", 500, html);
}

export class NHPClient {
  constructor(config = {}) {
    this.jar = new CookieJar();
    this.cookiePath = config.cookiePath || new URL("cookies.json", import.meta.url);
    this.credentials = config.credentials || null;
    this.userAgent = config.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    // NHP's portal is extremely slow; order/invoice listings alone can take
    // over a minute, so the default timeout is deliberately generous.
    this.timeoutMs = config.timeoutMs || 120000;
    this.logger = config.logger || new Logger({ isJson: config.silent, verbose: false });
    this._isSessionVerified = false;
    this._authPromise = null;
    this._cachedToken = null;
  }

  async init() {
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

  // A request that lands on the login or access-denied page means the session
  // is stale; throw a 401 so _withAuthRetry re-authenticates and retries.
  _assertAuthenticated(response) {
    const url = (response.url || "").toLowerCase();
    if (url.includes("/login") || url.includes("/access-denied")) {
      throw new NHPAPIError("Redirected to the login/access-denied page. Session is not authenticated.", 401, "");
    }
  }

  // POST an api/cxa form endpoint with the anti-forgery token and parse the
  // JSON response.
  async _postForm(label, url, params, referer) {
    const formToken = await this._getAntiForgeryToken();
    params.append("__RequestVerificationToken", formToken);

    const response = await this._fetch(url, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "__RequestVerificationToken": formToken,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer,
      },
      body: params.toString(),
    });

    this._assertAuthenticated(response);
    const responseText = await response.text();
    if (!response.ok) {
      throw new NHPAPIError(`${label} API returned status ${response.status}`, response.status, responseText);
    }

    try {
      return JSON.parse(responseText);
    } catch {
      if (responseText.includes("Server Error") || responseText.includes("Runtime Error")) {
        throw new NHPAPIError("The NHP server returned a '500 Server Error' page. This typically indicates a backend system crash.", 500, responseText);
      }
      throw new NHPAPIError(`[${label} API] Failed to parse response JSON. Response starts with: ${responseText.substring(0, 100)}`, response.status, responseText);
    }
  }

  async verifySession() {
    if (!this.jar.has(".AspNet.Cookies") && !this.jar.has("Nhp.AuthToken")) {
      return false;
    }
    try {
      const response = await this._fetch("https://www.nhpnz.co.nz/accountmanagement");
      await response.text();
      if (response.url.toLowerCase().includes("/login")) {
        return false;
      }
      return response.ok;
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
        // Reuse saved cookies optimistically; if they turn out to be stale,
        // _withAuthRetry re-authenticates and retries the request.
        if (this.jar.has(".AspNet.Cookies") || this.jar.has("Nhp.AuthToken")) {
          this.logger.debug(`[Auth] Reusing saved session cookies.`);
          this._isSessionVerified = true;
          return;
        }
        this.logger.debug(`[Auth] No saved session cookies. Performing login...`);
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

  async performLogin() {
    this._cachedToken = null;
    this.jar.clear();
    const creds = this.credentials || await loadCredentials();

    this.logger.debug(`[1/2] Fetching login page to get cookies and CRSF token...`);
    const getResp = await this._fetch("https://www.nhpnz.co.nz/login", {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });

    const html = await getResp.text();
    const crsfToken = extractToken(html);
    this.logger.debug(`- Extracted CRSF Token: ${crsfToken.substring(0, 15)}...`);

    this.logger.debug(`[2/2] Submitting login credentials...`);
    const bodyParams = new URLSearchParams();
    bodyParams.append("__RequestVerificationToken", crsfToken);
    bodyParams.append("UserName", creds.username);
    bodyParams.append("Password", creds.password);
    bodyParams.append("RememberMe", "false");
    bodyParams.append("X-Requested-With", "XMLHttpRequest");

    const postResp = await this._fetch("https://www.nhpnz.co.nz/api/cxa/NhpAccount/Login", {
      method: "POST",
      headers: {
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Referer": "https://www.nhpnz.co.nz/login",
      },
      body: bodyParams.toString(),
    });

    if (!postResp.ok) {
      throw new NHPAPIError(`Login POST request failed with status: ${postResp.status}`, postResp.status, await postResp.text());
    }

    const postBody = await postResp.text();
    let isSuccess = false;
    try {
      const json = JSON.parse(postBody);
      isSuccess = json.Success;
    } catch {
      isSuccess = postResp.status === 200;
    }

    if (isSuccess) {
      this.logger.debug(`[Auth] Login successful. Cookies saved.`);
    } else {
      throw new NHPAPIError(`Login response indicates failure.`, postResp.status, postBody);
    }
  }

  getSearchUserId() {
    for (const name of this.jar.names()) {
      if (name.startsWith("sc_") && name.length > 20) {
        return this.jar.get(name);
      }
    }
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "00000000-0000-0000-0000-000000000000";
  }

  async _withAuthRetry(fn) {
    await this.ensureLogin();
    try {
      return await fn();
    } catch (err) {
      const isAuthError = err instanceof NHPAPIError && (
        err.statusCode === 401 ||
        err.statusCode === 403 ||
        err.statusCode === 419 ||
        err.statusCode === 420 || // NHP rejects stale sessions/anti-forgery tokens with 420
        err.message.includes("VerificationToken") ||
        (err.responseBody && err.responseBody.toLowerCase().includes("/login")) ||
        (err.responseBody && err.responseBody.includes("error=unauthorized"))
      );

      if (isAuthError) {
        this.logger.debug(`[Auth] API call failed with suspected auth error. Retrying login once...`);
        this._isSessionVerified = false;
        await this.ensureLogin(true);
        return await fn();
      }
      throw err;
    }
  }

  async _getAntiForgeryToken() {
    if (this._cachedToken) {
      return this._cachedToken;
    }

    const cookieToken = this.jar.get("__RequestVerificationToken");
    if (!cookieToken) {
      throw new NHPAPIError("No RequestVerificationToken cookie found.", 401, "");
    }
    const tokenResp = await this._fetch("https://www.nhpnz.co.nz/api/antiforgerytoken/get");

    if (!tokenResp.ok) {
      throw new NHPAPIError(`Failed to fetch anti-forgery token from API.`, tokenResp.status, await tokenResp.text());
    }
    const tokenText = await tokenResp.text();
    let formToken = "";
    try {
      const json = JSON.parse(tokenText);
      formToken = json.__RequestVerificationToken || json.token || json.Token || json.Value || json.value;
    } catch {
      formToken = tokenText.replace(/['"]/g, '').trim();
    }
    if (!formToken) {
      throw new NHPAPIError("Failed to parse anti-forgery token from response.", tokenResp.status, tokenText);
    }
    this._cachedToken = formToken;
    return formToken;
  }

  searchProducts(query) {
    return this._withAuthRetry(async () => {
      const userId = this.getSearchUserId();
      const searchQ = JSON.stringify({
        "widget": {
          "items": [{
              "rfk_id": "rfkid_6",
              "entity": "product",
              "search": { "content": {}, "limit": 10, "query": { "keyphrase": query }, "suggestion": [{ "max": 10, "name": "product_name_did_you_mean", "keyphrase_fallback": true }] }
          }]
        },
        "context": { "locale": { "country": "nz", "language": "en" }, "user": { "user_id": userId } }
      });

      const response = await this._fetch("https://www.nhpnz.co.nz/api/xmc-next/search", {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "x-bypass-data-massage": "true",
          "Referer": "https://www.nhpnz.co.nz/",
        },
        body: searchQ,
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Search API returned status ${response.status}`, response.status, responseText);
      }
      try {
        return JSON.parse(responseText);
      } catch {
        throw new NHPAPIError(`[Search API] Failed to parse response JSON. Response starts with: ${responseText.substring(0, 100)}`, response.status, responseText);
      }
    });
  }

  getPriceAndStock(products) {
    return this._withAuthRetry(() => {
      const params = new URLSearchParams();
      for (let i = 0; i < products.length; i++) {
        params.append(`productList[${i}][ItemId]`, products[i].itemId);
        params.append(`productList[${i}][Qty]`, String(products[i].qty));
      }
      params.append("isDefaultToMinimum", "true");

      return this._postForm(
        "Pricing",
        "https://www.nhpnz.co.nz/api/cxa/availabilityandprice/getproductavailabilityandprice?sc_site=NZ",
        params,
        "https://www.nhpnz.co.nz/account/price-and-availability",
      );
    });
  }

  _historyParams(options) {
    const params = new URLSearchParams();
    params.append("documentNumber", options.documentNumber || "");
    params.append("orderNumber", options.orderNumber || "");
    params.append("purchaseNumber", options.purchaseNumber || "");
    params.append("customerReference", options.customerReference || "");
    params.append("dateFrom", options.dateFrom || "");
    params.append("dateTo", options.dateTo || "");
    return params;
  }

  getOrders(pageSize = 20, offset = 0, options = {}) {
    return this._withAuthRetry(() =>
      this._postForm(
        "Orders",
        `https://www.nhpnz.co.nz/api/cxa/NhpOrders/GetOrderHistory?&pageSize=${pageSize}&offset=${offset}&sc_site=NZ`,
        this._historyParams(options),
        "https://www.nhpnz.co.nz/accountmanagement/myorders",
      )
    );
  }

  getInvoices(pageSize = 20, offset = 0, options = {}) {
    return this._withAuthRetry(() =>
      this._postForm(
        "Invoices",
        `https://www.nhpnz.co.nz/api/cxa/NhpOrders/GetInvoiceHistory?type=invoice&pageSize=${pageSize}&offset=${offset}&sc_site=NZ`,
        this._historyParams(options),
        "https://www.nhpnz.co.nz/accountmanagement/invoices",
      )
    );
  }

  parseDetailsHeader(document) {
    const header = {};
    const detailItems = document.querySelectorAll('.c-order-details__item');
    for (const item of detailItems) {
      const label = item.querySelector('.c-order-details__label')?.textContent.replace(':', '').trim();
      const value = item.querySelector('.c-order-details__value')?.textContent.trim();
      if (label) header[label] = value || "";
    }
    const addresses = {};
    const addrItems = document.querySelectorAll('.c-credit-note-address__item');
    for (const item of addrItems) {
      const title = item.querySelector('h3')?.textContent.trim();
      const value = item.querySelector('p')?.textContent.trim();
      if (title) addresses[title] = value || "";
    }
    return { header, addresses };
  }

  // Fetches and scrapes an order/invoice details page.
  _getDetails(label, url, includeShipping) {
    return this._withAuthRetry(async () => {
      const response = await this._fetch(url, {
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      this._assertAuthenticated(response);
      const html = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Failed to fetch ${label} details. Status: ${response.status}`, response.status, html);
      }

      const document = new DOMParser().parseFromString(html, "text/html");
      if (!document) throw new NHPAPIError("Failed to parse HTML document.", response.status, html);

      const { header, addresses } = this.parseDetailsHeader(document);
      const items = [];
      const rows = document.querySelectorAll('.c-order-table__row');

      for (const row of rows) {
        const item = {
          Description: row.querySelector('h4')?.textContent.trim() || "",
          ProductCode: row.querySelector('p')?.textContent.trim() || "",
          UnitPrice: row.querySelector('.c-order-table__price')?.textContent.trim() || "",
          Quantity: row.querySelector('.c-order-table__qty')?.textContent.trim() || "",
          Total: row.querySelector('.c-order-table__total')?.textContent.trim() || "",
        };
        if (includeShipping) {
          item.RemainingQuantity = row.querySelector('.c-order-table__remqty')?.textContent.trim() || "";
          item.UOM = row.querySelector('.c-order-table__uom')?.textContent.trim() || "";
          item.Status = row.querySelector('.c-order-table__eta')?.textContent.replace(/\s+/g, ' ').trim() || "";
        }
        if (item.Description && item.ProductCode) {
          items.push(item);
        }
      }
      return { header, addresses, items };
    });
  }

  getOrderDetails(orderId) {
    return this._getDetails(
      "order",
      `https://www.nhpnz.co.nz/accountmanagement/myorders/myorder?id=${encodeURIComponent(orderId)}`,
      true,
    );
  }

  getInvoiceDetails(invoiceId) {
    return this._getDetails(
      "invoice",
      `https://www.nhpnz.co.nz/accountmanagement/invoices/invoice?id=${encodeURIComponent(invoiceId)}`,
      false,
    );
  }

  addToCart(productId, quantity = 1) {
    return this._withAuthRetry(() => {
      const params = new URLSearchParams();
      params.append("addtocart_catalogname", "NHP_NZ_Catalog");
      params.append("addtocart_productid", productId);
      params.append("addtocart_variantid", "");
      params.append("quantity", String(quantity));

      return this._postForm(
        "Cart Add",
        "https://www.nhpnz.co.nz/api/cxa/Cart/AddCartLine",
        params,
        `https://www.nhpnz.co.nz/product/${encodeURIComponent(productId)}`,
      );
    });
  }

  getCart() {
    return this._withAuthRetry(() =>
      this._postForm(
        "Get Cart",
        "https://www.nhpnz.co.nz/api/cxa/Cart/GetCart?sc_site=NZ",
        new URLSearchParams(),
        "https://www.nhpnz.co.nz/shoppingcart",
      )
    );
  }

  removeCartLine(lineNumber) {
    return this._withAuthRetry(() => {
      const params = new URLSearchParams();
      params.append("lineNumber", lineNumber);
      return this._postForm(
        "Remove Cart Line",
        "https://www.nhpnz.co.nz/api/cxa/Cart/RemoveShoppingCartLine?sc_site=NZ",
        params,
        "https://www.nhpnz.co.nz/shoppingcart",
      );
    });
  }

  updateCartLineQuantity(lineNumber, quantity) {
    return this._withAuthRetry(() => {
      const params = new URLSearchParams();
      params.append("quantity", String(quantity));
      params.append("lineNumber", lineNumber);
      return this._postForm(
        "Update Cart Line",
        "https://www.nhpnz.co.nz/api/cxa/Cart/UpdateCartLineQuantity?sc_site=NZ",
        params,
        "https://www.nhpnz.co.nz/shoppingcart",
      );
    });
  }

  clearCart() {
    return this._withAuthRetry(() =>
      this._postForm(
        "Clear Cart",
        "https://www.nhpnz.co.nz/api/cxa/CustomCart/ClearCart?sc_site=NZ",
        new URLSearchParams(),
        "https://www.nhpnz.co.nz/shoppingcart",
      )
    );
  }

  // Uploads a CSV to the cart. The upload page only reports failures via
  // client-side scripts, so the result is verified against the cart itself:
  // returns { success, requested, missing } where missing lists part numbers
  // that did not end up in the cart.
  async uploadCartCsvContent(csvData, fileName = "upload.csv") {
    await this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const formData = new FormData();
      formData.append("__RequestVerificationToken", formToken);
      formData.append("CSVFile", new Blob([csvData], { type: "application/vnd.ms-excel" }), fileName);

      const response = await this._fetch("https://www.nhpnz.co.nz/accountmanagement/shoppingcartupload", {
        method: "POST",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Upgrade-Insecure-Requests": "1",
          "Referer": "https://www.nhpnz.co.nz/accountmanagement/shoppingcartupload",
        },
        body: formData,
      });

      this._assertAuthenticated(response);
      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Upload Cart CSV API returned status ${response.status}`, response.status, responseText);
      }
    });

    const requested = parseCsvText(csvData);
    const requestedIds = requested.map((p) => p.itemId);
    let missing = await this._findMissingInCart(requestedIds);
    if (missing.length > 0) {
      // The upload may still be processing; NHP is slow. Check once more.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      missing = await this._findMissingInCart(missing);
    }

    // The upload endpoint silently drops lines it can't fulfil from stock
    // (e.g. backorder-only parts), so retry stragglers individually via
    // AddCartLine, which supports backorders and reports real reasons.
    const warnings = [];
    if (missing.length > 0) {
      for (const pn of missing) {
        const item = requested.find((p) => p.itemId.toLowerCase() === pn.toLowerCase());
        try {
          const result = await this.addToCart(pn, item?.qty ?? 1);
          for (const w of result?.Warnings || []) warnings.push(w);
          for (const e of result?.Errors || []) warnings.push(e);
        } catch (err) {
          warnings.push(`${pn}: ${err.message}`);
        }
      }
      missing = await this._findMissingInCart(missing);
    }

    return { success: missing.length === 0, requested: requestedIds, missing, Warnings: warnings };
  }

  async _findMissingInCart(partNumbers) {
    const cart = await this.getCart();
    const lines = cart?.Lines || [];
    return partNumbers.filter((pn) => !lines.some((l) => l.SKUID?.toLowerCase() === pn.toLowerCase()));
  }

  async uploadCartCsv(csvFilePath) {
    const csvData = await Deno.readTextFile(csvFilePath);
    // The upload endpoint silently rejects anything but the exact
    // "Part Number,Quantity" format, so normalize whatever we were given
    // (single-column lists, quoted fields, missing header).
    const items = parseCsvText(csvData);
    let normalized = "Part Number,Quantity\r\n";
    for (const item of items) {
      normalized += `${item.itemId},${item.qty}\r\n`;
    }
    const fileName = csvFilePath.split(/[/\\]/).pop();
    return await this.uploadCartCsvContent(normalized, fileName);
  }
}
