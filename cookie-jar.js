import { readTextFile, writeTextFile } from "./fs_adapter.js";

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  acceptCookies(headers) {
    if (typeof headers.getSetCookie === 'function') {
      for (const setCookie of headers.getSetCookie()) {
        const part = setCookie.split(';')[0];
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) {
          const key = part.substring(0, eqIdx).trim();
          const val = part.substring(eqIdx + 1).trim();
          this.cookies.set(key, val);
        }
      }
    } else {
      const setCookie = headers.get('set-cookie');
      if (setCookie) {
        const cookies = setCookie.split(',');
        for (const cookie of cookies) {
          const part = cookie.split(';')[0];
          const eqIdx = part.indexOf('=');
          if (eqIdx !== -1) {
            const key = part.substring(0, eqIdx).trim();
            const val = part.substring(eqIdx + 1).trim();
            this.cookies.set(key, val);
          }
        }
      }
    }
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async saveToFile(filePath) {
    const data = JSON.stringify(Array.from(this.cookies.entries()), null, 2);
    await writeTextFile(filePath, data);
  }

  async loadFromFile(filePath) {
    try {
      const data = await readTextFile(filePath);
      const entries = JSON.parse(data);
      this.cookies = new Map(entries);
    } catch {
      this.cookies = new Map();
    }
  }
}
