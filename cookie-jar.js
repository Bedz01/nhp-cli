import { getSetCookies } from "jsr:@std/http/cookie";

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  acceptCookies(headers) {
    const setCookies = getSetCookies(headers);
    for (const cookie of setCookies) {
      this.cookies.set(cookie.name, cookie.value);
    }
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async saveToFile(filePath) {
    const data = JSON.stringify(Array.from(this.cookies.entries()), null, 2);
    await Deno.writeTextFile(filePath, data);
  }

  async loadFromFile(filePath) {
    try {
      const data = await Deno.readTextFile(filePath);
      const entries = JSON.parse(data);
      this.cookies = new Map(entries);
    } catch {
      this.cookies = new Map();
    }
  }
}
