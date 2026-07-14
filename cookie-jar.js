import { getSetCookies } from "jsr:@std/http@^1/cookie";

export class CookieJar {
  constructor() {
    // name -> { value, expires? } where expires is a ms-epoch timestamp
    this.cookies = new Map();
    this._saveQueue = Promise.resolve();
  }

  acceptCookies(headers) {
    for (const cookie of getSetCookies(headers)) {
      let expires;
      if (typeof cookie.maxAge === "number") {
        expires = Date.now() + cookie.maxAge * 1000;
      } else if (cookie.expires instanceof Date) {
        expires = cookie.expires.getTime();
      } else if (typeof cookie.expires === "number") {
        expires = cookie.expires;
      }

      if (expires !== undefined && expires <= Date.now()) {
        // A Set-Cookie that is already expired is the server deleting the cookie
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, { value: cookie.value, expires });
      }
    }
  }

  _live(entry) {
    return entry !== undefined && (entry.expires === undefined || entry.expires > Date.now());
  }

  get(name) {
    const entry = this.cookies.get(name);
    return this._live(entry) ? entry.value : undefined;
  }

  has(name) {
    return this.get(name) !== undefined;
  }

  names() {
    return Array.from(this.cookies.entries())
      .filter(([, entry]) => this._live(entry))
      .map(([name]) => name);
  }

  clear() {
    this.cookies.clear();
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .filter(([, entry]) => this._live(entry))
      .map(([name, entry]) => `${name}=${entry.value}`)
      .join("; ");
  }

  saveToFile(filePath) {
    // Serialize writes so concurrent requests can't interleave partial files
    const task = this._saveQueue.then(() => {
      const entries = Array.from(this.cookies.entries()).filter(([, entry]) => this._live(entry));
      return Deno.writeTextFile(filePath, JSON.stringify(entries, null, 2));
    });
    this._saveQueue = task.catch(() => {});
    return task;
  }

  async loadFromFile(filePath) {
    try {
      const data = await Deno.readTextFile(filePath);
      const entries = JSON.parse(data);
      // Supports both the legacy [name, "value"] format and the current [name, { value, expires }]
      this.cookies = new Map(entries.map(([name, v]) => [name, typeof v === "string" ? { value: v } : v]));
    } catch {
      this.cookies = new Map();
    }
  }
}
