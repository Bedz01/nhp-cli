import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.56/deno-dom-wasm.ts";
import { CookieJar } from "./cookie-jar.js";
import { extractToken, loadCredentials } from "./utils.js";

export class NHPClient {
  constructor(config = {}) {
    this.jar = new CookieJar();
    this.cookiePath = config.cookiePath || "cookies.json";
    this.credentials = config.credentials || null;
    this.userAgent = config.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    this.silent = config.silent || false;
    this.logger = config.logger || {
      log: (...args) => { if (!this.silent) console.log(...args); },
      error: (...args) => { if (!this.silent) console.error(...args); },
      warn: (...args) => { if (!this.silent) console.warn(...args); }
    };
  }

  async init() {
    await this.jar.loadFromFile(this.cookiePath);
  }

  async verifySession() {
    // Check if critical session cookies are present
    if (!this.jar.cookies.has(".AspNet.Cookies") && !this.jar.cookies.has("Nhp.AuthToken")) {
      return false;
    }

    try {
      // Fetch a protected page to verify the session is still active on the server
      const response = await fetch("https://www.nhpnz.co.nz/accountmanagement", {
        headers: {
          "User-Agent": this.userAgent,
          "Cookie": this.jar.getCookieHeader(),
        }
      });
      // If the server redirects us to the login page, the session is expired
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
      this.logger.log(`[Auth] Checking if saved session cookies are valid...`);
      const isValid = await this.verifySession();
      if (isValid) {
        this.logger.log(`[Auth] Saved session is valid. Reusing cookies.`);
        return;
      }
      this.logger.log(`[Auth] Saved session is invalid or expired. Performing login...`);
    } else {
      this.logger.log(`[Auth] Force login requested. Logging in...`);
    }

    await this.performLogin();
  }

  async performLogin() {
    this.jar.cookies.clear(); // Clear old cookies to start a fresh session and avoid 420 errors
    const creds = this.credentials || await loadCredentials();
    
    this.logger.log(`[1/2] Fetching login page to get cookies and CRSF token...`);
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
    this.logger.log(`- Extracted CRSF Token: ${crsfToken.substring(0, 15)}...`);

    this.logger.log(`[2/2] Submitting login credentials...`);
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
      throw new Error(`Login POST request failed with status: ${postResp.status}`);
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
      this.logger.log(`[Auth] Login successful. Saving cookies to ${this.cookiePath}...`);
      await this.jar.saveToFile(this.cookiePath);
    } else {
      throw new Error(`Login response indicates failure: ${postBody}`);
    }
  }

  getSearchUserId() {
    // 1. Try to find the dynamic Sitecore Discover tracking cookie
    for (const key of this.jar.cookies.keys()) {
      if (key.startsWith("sc_") && key.length > 20) {
        return this.jar.cookies.get(key);
      }
    }
    // 2. Fallback to a random UUID if not found (standard for Sitecore tracking)
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "00000000-0000-0000-0000-000000000000";
  }

  async searchProducts(query) {
    const userId = this.getSearchUserId();
    
    const searchQ = JSON.stringify({
      "widget": {
        "items": [
          {
            "rfk_id": "rfkid_6",
            "entity": "product",
            "search": {
              "content": {},
              "limit": 10,
              "query": {
                "keyphrase": query
              },
              "suggestion": [
                {
                  "max": 10,
                  "name": "product_name_did_you_mean",
                  "keyphrase_fallback": true
                }
              ]
            }
          }
        ]
      },
      "context": {
        "locale": {
          "country": "nz",
          "language": "en"
        },
        "user": {
          "user_id": userId
        }
      }
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
      throw new Error(`Search API returned status ${response.status}`);
    }

    return await response.json();
  }

  async getPriceAndStock(products) {
    const cookieToken = this.jar.cookies.get("__RequestVerificationToken");
    if (!cookieToken) {
      throw new Error("No RequestVerificationToken cookie found. Ensure user is logged in.");
    }

    // Fetch the real form token from the anti-forgery endpoint
    const tokenResp = await fetch("https://www.nhpnz.co.nz/api/antiforgerytoken/get", {
      headers: {
        "User-Agent": this.userAgent,
        "Cookie": this.jar.getCookieHeader()
      }
    });
    const tokenText = await tokenResp.text();
    let formToken = "";
    try {
        const json = JSON.parse(tokenText);
        formToken = json.__RequestVerificationToken || json.token || json.Token || json.Value || json.value;
    } catch {
        formToken = tokenText.replace(/['"]/g, '').trim();
    }
    
    this.jar.acceptCookies(tokenResp.headers);
    
    if (!formToken) {
        throw new Error("Failed to fetch anti-forgery token from API.");
    }

    const bodyParams = new URLSearchParams();
    bodyParams.append("__RequestVerificationToken", formToken);
    for (let i = 0; i < products.length; i++) {
      bodyParams.append(`productList[${i}][ItemId]`, products[i].itemId);
      bodyParams.append(`productList[${i}][Qty]`, String(products[i].qty));
    }
    bodyParams.append("isDefaultToMinimum", "true");

    const url = "https://www.nhpnz.co.nz/api/cxa/availabilityandprice/getproductavailabilityandprice?sc_site=NZ";
    const bodyStr = bodyParams.toString();
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
      body: bodyStr,
    });

    this.jar.acceptCookies(response.headers);
    await this.jar.saveToFile(this.cookiePath);

    const responseText = await response.text();
    if (!response.ok) {
      this.logger.error("SERVER ERROR RESPONSE BODY:");
      this.logger.error(responseText);
      throw new Error(`Pricing API returned status ${response.status}`);
    }

    try {
      return JSON.parse(responseText);
    } catch {
      this.logger.error("SERVER ERROR RESPONSE (Returned as 200 OK, but likely a 500 page):");
      this.logger.error(responseText.substring(0, 1000));
      if (responseText.includes("Server Error") || responseText.includes("Runtime Error")) {
        throw new Error("The NHP server returned a '500 Server Error' page. This typically indicates a backend system crash or catalog access restriction.");
      }
      throw new Error(`Failed to parse response JSON. Response starts with: ${responseText.substring(0, 200)}`);
    }
  }

  async getOrders(pageSize = 20, offset = 0, options = {}) {
    const cookieToken = this.jar.cookies.get("__RequestVerificationToken");
    if (!cookieToken) {
      throw new Error("No RequestVerificationToken cookie found. Ensure user is logged in.");
    }

    // Fetch the real form token from the anti-forgery endpoint
    const tokenResp = await fetch("https://www.nhpnz.co.nz/api/antiforgerytoken/get", {
      headers: {
        "User-Agent": this.userAgent,
        "Cookie": this.jar.getCookieHeader()
      }
    });
    const tokenText = await tokenResp.text();
    let formToken = "";
    try {
        const json = JSON.parse(tokenText);
        formToken = json.__RequestVerificationToken || json.token || json.Token || json.Value || json.value;
    } catch {
        formToken = tokenText.replace(/['"]/g, '').trim();
    }
    
    this.jar.acceptCookies(tokenResp.headers);
    
    if (!formToken) {
        throw new Error("Failed to fetch anti-forgery token from API.");
    }

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
      this.logger.error("SERVER ERROR RESPONSE BODY:");
      this.logger.error(responseText);
      throw new Error(`Orders API returned status ${response.status}`);
    }

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error(`Failed to parse response JSON. Response starts with: ${responseText.substring(0, 200)}`);
    }
  }

  async getInvoices(pageSize = 20, offset = 0, options = {}) {
    const cookieToken = this.jar.cookies.get("__RequestVerificationToken");
    if (!cookieToken) {
      throw new Error("No RequestVerificationToken cookie found. Ensure user is logged in.");
    }

    const tokenResp = await fetch("https://www.nhpnz.co.nz/api/antiforgerytoken/get", {
      headers: {
        "User-Agent": this.userAgent,
        "Cookie": this.jar.getCookieHeader()
      }
    });
    const tokenText = await tokenResp.text();
    let formToken = "";
    try {
        const json = JSON.parse(tokenText);
        formToken = json.__RequestVerificationToken || json.token || json.Token || json.Value || json.value;
    } catch {
        formToken = tokenText.replace(/['"]/g, '').trim();
    }
    
    this.jar.acceptCookies(tokenResp.headers);
    
    if (!formToken) {
        throw new Error("Failed to fetch anti-forgery token from API.");
    }

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
      this.logger.error("SERVER ERROR RESPONSE BODY:");
      this.logger.error(responseText);
      throw new Error(`Invoices API returned status ${response.status}`);
    }

    try {
      return JSON.parse(responseText);
    } catch {
      throw new Error(`Failed to parse response JSON. Response starts with: ${responseText.substring(0, 200)}`);
    }
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
    await this.ensureLogin();
    
    const url = `https://www.nhpnz.co.nz/accountmanagement/myorders/myorder?id=${orderId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": this.userAgent,
        "Cookie": this.jar.getCookieHeader(),
      }
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch order details. Status: ${response.status}`);
    }

    const document = new DOMParser().parseFromString(html, "text/html");
    if (!document) {
      throw new Error("Failed to parse HTML document.");
    }

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
        items.push({
          Description,
          ProductCode,
          UnitPrice,
          Quantity,
          RemainingQuantity,
          UOM,
          Status,
          Total
        });
      }
    }

    return { header, addresses, items };
  }

  async getInvoiceDetails(invoiceId) {
    await this.ensureLogin();
    
    const url = `https://www.nhpnz.co.nz/accountmanagement/invoices/invoice?id=${invoiceId}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": this.userAgent,
        "Cookie": this.jar.getCookieHeader(),
      }
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch invoice details. Status: ${response.status}`);
    }

    const document = new DOMParser().parseFromString(html, "text/html");
    if (!document) {
      throw new Error("Failed to parse HTML document.");
    }

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
        items.push({
          Description,
          ProductCode,
          UnitPrice,
          Quantity,
          Total
        });
      }
    }

    return { header, addresses, items };
  }
}
