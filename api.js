import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.56/deno-dom-wasm.ts";
import { CookieJar } from "./cookie-jar.js";
import { loadCredentials } from "./config.js";
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
    this.cookiePath = config.cookiePath || "cookies.json";
    this.credentials = config.credentials || null;
    this.userAgent = config.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    this.logger = config.logger || new Logger({ isJson: config.silent, verbose: false });
    this._isSessionVerified = false;
  }

  async init() {
    await this.jar.loadFromFile(this.cookiePath);
  }

  async verifySession() {
    if (!this.jar.cookies.has(".AspNet.Cookies") && !this.jar.cookies.has("Nhp.AuthToken")) {
      return false;
    }
    try {
      const response = await fetch("https://www.nhpnz.co.nz/accountmanagement", {
        headers: {
          "User-Agent": this.userAgent,
          "Cookie": this.jar.getCookieHeader(),
        }
      });
      if (response.url.toLowerCase().includes("/login")) {
        return false;
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureLogin(force = false) {
    await this.init();
    if (!force) {
      if (this._isSessionVerified) return;
      this.logger.debug(`[Auth] Checking if saved session cookies are valid...`);
      const isValid = await this.verifySession();
      if (isValid) {
        this.logger.debug(`[Auth] Saved session is valid. Reusing cookies.`);
        this._isSessionVerified = true;
        return;
      }
      this.logger.debug(`[Auth] Saved session is invalid or expired. Performing login...`);
    } else {
      this.logger.debug(`[Auth] Force login requested. Logging in...`);
    }

    await this.performLogin();
    this._isSessionVerified = true;
  }

  async performLogin() {
    this.jar.cookies.clear();
    const creds = this.credentials || await loadCredentials();
    
    this.logger.debug(`[1/2] Fetching login page to get cookies and CRSF token...`);
    const getResp = await fetch("https://www.nhpnz.co.nz/login", {
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });

    this.jar.acceptCookies(getResp.headers);
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

    const postResp = await fetch("https://www.nhpnz.co.nz/api/cxa/NhpAccount/Login", {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Cookie": this.jar.getCookieHeader(),
        "Referer": "https://www.nhpnz.co.nz/login",
      },
      body: bodyParams.toString(),
    });

    this.jar.acceptCookies(postResp.headers);
    
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
      this.logger.debug(`[Auth] Login successful. Saving cookies to ${this.cookiePath}...`);
      await this.jar.saveToFile(this.cookiePath);
    } else {
      throw new NHPAPIError(`Login response indicates failure.`, postResp.status, postBody);
    }
  }

  getSearchUserId() {
    for (const key of this.jar.cookies.keys()) {
      if (key.startsWith("sc_") && key.length > 20) {
        return this.jar.cookies.get(key);
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
    const cookieToken = this.jar.cookies.get("__RequestVerificationToken");
    if (!cookieToken) {
      throw new NHPAPIError("No RequestVerificationToken cookie found.", 401, "");
    }
    const tokenResp = await fetch("https://www.nhpnz.co.nz/api/antiforgerytoken/get", {
      headers: {
        "User-Agent": this.userAgent,
        "Cookie": this.jar.getCookieHeader()
      }
    });
    
    this.jar.acceptCookies(tokenResp.headers);
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
    return formToken;
  }

  async searchProducts(query) {
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

      const response = await fetch("https://www.nhpnz.co.nz/api/xmc-next/search", {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/json",
          "x-bypass-data-massage": "true",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/",
        },
        body: searchQ,
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      if (!response.ok) {
        throw new NHPAPIError(`Search API returned status ${response.status}`, response.status, await response.text());
      }
      return await response.json();
    });
  }

  async getPriceAndStock(products) {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("__RequestVerificationToken", formToken);
      for (let i = 0; i < products.length; i++) {
        bodyParams.append(`productList[${i}][ItemId]`, products[i].itemId);
        bodyParams.append(`productList[${i}][Qty]`, String(products[i].qty));
      }
      bodyParams.append("isDefaultToMinimum", "true");

      const url = "https://www.nhpnz.co.nz/api/cxa/availabilityandprice/getproductavailabilityandprice?sc_site=NZ";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "__RequestVerificationToken": formToken,
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/account/price-and-availability",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Pricing API returned status ${response.status}`, response.status, responseText);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        if (responseText.includes("Server Error") || responseText.includes("Runtime Error")) {
          throw new NHPAPIError("The NHP server returned a '500 Server Error' page. This typically indicates a backend system crash.", 500, responseText);
        }
        throw new NHPAPIError(`[Pricing API] Failed to parse response JSON. Response starts with: ${responseText.substring(0, 100)}`, response.status, responseText);
      }
    });
  }

  async getOrders(pageSize = 20, offset = 0, options = {}) {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("documentNumber", options.documentNumber || "");
      bodyParams.append("orderNumber", options.orderNumber || "");
      bodyParams.append("purchaseNumber", options.purchaseNumber || "");
      bodyParams.append("customerReference", options.customerReference || "");
      bodyParams.append("dateFrom", options.dateFrom || "");
      bodyParams.append("dateTo", options.dateTo || "");
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = `https://www.nhpnz.co.nz/api/cxa/NhpOrders/GetOrderHistory?&pageSize=${pageSize}&offset=${offset}&sc_site=NZ`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "__RequestVerificationToken": formToken,
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/accountmanagement/myorders",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Orders API returned status ${response.status}`, response.status, responseText);
      }
      try { return JSON.parse(responseText); } 
      catch { throw new NHPAPIError(`[Orders API] Failed to parse response JSON. Response starts with: ${responseText.substring(0, 100)}`, response.status, responseText); }
    });
  }

  async getInvoices(pageSize = 20, offset = 0, options = {}) {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("documentNumber", options.documentNumber || "");
      bodyParams.append("orderNumber", options.orderNumber || "");
      bodyParams.append("purchaseNumber", options.purchaseNumber || "");
      bodyParams.append("customerReference", options.customerReference || "");
      bodyParams.append("dateFrom", options.dateFrom || "");
      bodyParams.append("dateTo", options.dateTo || "");
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = `https://www.nhpnz.co.nz/api/cxa/NhpOrders/GetInvoiceHistory?type=invoice&pageSize=${pageSize}&offset=${offset}&sc_site=NZ`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "__RequestVerificationToken": formToken,
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/accountmanagement/invoices",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Invoices API returned status ${response.status}`, response.status, responseText);
      }
      try { return JSON.parse(responseText); } 
      catch { throw new NHPAPIError(`[Invoices API] Failed to parse response JSON. Response starts with: ${responseText.substring(0, 100)}`, response.status, responseText); }
    });
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

  async getOrderDetails(orderId) {
    return this._withAuthRetry(async () => {
      const url = `https://www.nhpnz.co.nz/accountmanagement/myorders/myorder?id=${orderId}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          "Cookie": this.jar.getCookieHeader(),
        }
      });
      const html = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Failed to fetch order details. Status: ${response.status}`, response.status, html);
      }

      const document = new DOMParser().parseFromString(html, "text/html");
      if (!document) throw new NHPAPIError("Failed to parse HTML document.", response.status, html);

      const { header, addresses } = this.parseDetailsHeader(document);
      const items = [];
      const rows = document.querySelectorAll('.c-order-table__row');
      
      for (const row of rows) {
        const Description = row.querySelector('h4')?.textContent.trim() || "";
        const ProductCode = row.querySelector('p')?.textContent.trim() || "";
        const UnitPrice = row.querySelector('.c-order-table__price')?.textContent.trim() || "";
        const Quantity = row.querySelector('.c-order-table__qty')?.textContent.trim() || "";
        const RemainingQuantity = row.querySelector('.c-order-table__remqty')?.textContent.trim() || "";
        const UOM = row.querySelector('.c-order-table__uom')?.textContent.trim() || "";
        const Status = row.querySelector('.c-order-table__eta')?.textContent.replace(/\s+/g, ' ').trim() || "";
        const Total = row.querySelector('.c-order-table__total')?.textContent.trim() || "";

        if (Description && ProductCode) {
          items.push({ Description, ProductCode, UnitPrice, Quantity, RemainingQuantity, UOM, Status, Total });
        }
      }
      return { header, addresses, items };
    });
  }

  async getInvoiceDetails(invoiceId) {
    return this._withAuthRetry(async () => {
      const url = `https://www.nhpnz.co.nz/accountmanagement/invoices/invoice?id=${invoiceId}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          "Cookie": this.jar.getCookieHeader(),
        }
      });

      const html = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Failed to fetch invoice details. Status: ${response.status}`, response.status, html);
      }

      const document = new DOMParser().parseFromString(html, "text/html");
      if (!document) throw new NHPAPIError("Failed to parse HTML document.", response.status, html);

      const { header, addresses } = this.parseDetailsHeader(document);
      const items = [];
      const rows = document.querySelectorAll('.c-order-table__row');
      
      for (const row of rows) {
        const Description = row.querySelector('h4')?.textContent.trim() || "";
        const ProductCode = row.querySelector('p')?.textContent.trim() || "";
        const UnitPrice = row.querySelector('.c-order-table__price')?.textContent.trim() || "";
        const Quantity = row.querySelector('.c-order-table__qty')?.textContent.trim() || "";
        const Total = row.querySelector('.c-order-table__total')?.textContent.trim() || "";

        if (Description && ProductCode) {
          items.push({ Description, ProductCode, UnitPrice, Quantity, Total });
        }
      }
      return { header, addresses, items };
    });
  }

  async addToCart(productId, quantity = 1) {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("addtocart_catalogname", "NHP_NZ_Catalog");
      bodyParams.append("addtocart_productid", productId);
      bodyParams.append("addtocart_variantid", "");
      bodyParams.append("quantity", String(quantity));
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = "https://www.nhpnz.co.nz/api/cxa/Cart/AddCartLine";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": `https://www.nhpnz.co.nz/product/${productId}`,
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Cart Add API returned status ${response.status}`, response.status, responseText);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        return { success: true, text: responseText };
      }
    });
  }

  async getCart() {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = "https://www.nhpnz.co.nz/api/cxa/Cart/GetCart?sc_site=NZ";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "__RequestVerificationToken": formToken,
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/shoppingcart",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Get Cart API returned status ${response.status}`, response.status, responseText);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        throw new NHPAPIError(`[Get Cart API] Failed to parse response JSON.`, response.status, responseText);
      }
    });
  }

  async removeCartLine(lineNumber) {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("lineNumber", lineNumber);
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = "https://www.nhpnz.co.nz/api/cxa/Cart/RemoveShoppingCartLine?sc_site=NZ";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "__RequestVerificationToken": formToken,
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/shoppingcart",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Remove Cart Line API returned status ${response.status}`, response.status, responseText);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        return { success: true, text: responseText };
      }
    });
  }

  async updateCartLineQuantity(lineNumber, quantity) {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("quantity", String(quantity));
      bodyParams.append("lineNumber", lineNumber);
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = "https://www.nhpnz.co.nz/api/cxa/Cart/UpdateCartLineQuantity?sc_site=NZ";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "__RequestVerificationToken": formToken,
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/shoppingcart",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Update Cart Line API returned status ${response.status}`, response.status, responseText);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        return { success: true, text: responseText };
      }
    });
  }

  async clearCart() {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      const bodyParams = new URLSearchParams();
      bodyParams.append("__RequestVerificationToken", formToken);

      const url = "https://www.nhpnz.co.nz/api/cxa/CustomCart/ClearCart?sc_site=NZ";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "__RequestVerificationToken": formToken,
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/shoppingcart",
        },
        body: bodyParams.toString(),
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Clear Cart API returned status ${response.status}`, response.status, responseText);
      }

      try {
        return JSON.parse(responseText);
      } catch {
        return { success: true, text: responseText };
      }
    });
  }

  async uploadCartCsvContent(csvData, fileName = "upload.csv") {
    return this._withAuthRetry(async () => {
      const formToken = await this._getAntiForgeryToken();
      
      const formData = new FormData();
      formData.append("__RequestVerificationToken", formToken);
      formData.append("CSVFile", new Blob([csvData], { type: "application/vnd.ms-excel" }), fileName);

      const url = "https://www.nhpnz.co.nz/accountmanagement/shoppingcartupload";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Upgrade-Insecure-Requests": "1",
          "Cookie": this.jar.getCookieHeader(),
          "Referer": "https://www.nhpnz.co.nz/accountmanagement/shoppingcartupload",
        },
        body: formData,
      });

      this.jar.acceptCookies(response.headers);
      await this.jar.saveToFile(this.cookiePath);

      const responseText = await response.text();
      if (!response.ok) {
        throw new NHPAPIError(`Upload Cart CSV API returned status ${response.status}`, response.status, responseText);
      }

      return { success: true, text: "CSV uploaded successfully." };
    });
  }

  async uploadCartCsv(csvFilePath) {
    const csvData = await Deno.readTextFile(csvFilePath);
    const fileName = csvFilePath.split(/[/\\]/).pop();
    return this.uploadCartCsvContent(csvData, fileName);
  }
}
