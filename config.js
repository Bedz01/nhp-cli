import { loadSettings, resolveCredentials } from "./store.js";

// loadConfig / loadCredentials are kept for library users of earlier
// versions; the CLI and the client go through store.js directly.
export async function loadConfig() {
  return await loadSettings();
}

export async function loadCredentials() {
  const creds = await resolveCredentials();
  if (!creds) throw new Error("Credentials not found. Run 'nhp login', or set NHP_USERNAME and NHP_PASSWORD.");
  return { username: creds.username, password: creds.password };
}

export function parseCsvText(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const items = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(",").map((p) => p.replace(/['"]/g, "").trim());
    const itemId = parts[0];
    if (!itemId) continue;

    if (parts.length === 1) {
      // Single-column list of part numbers. Part numbers never contain
      // whitespace, so anything with a space is a header row.
      if (/\s/.test(itemId) || /^(part|parts|item|items|product|products|sku|skus|partnumber|code)$/i.test(itemId)) continue;
      items.push({ itemId, qty: 1 });
    } else {
      const qty = parseInt(parts[1], 10);
      if (!isNaN(qty) && qty > 0) {
        items.push({ itemId, qty });
      }
    }
  }
  return items;
}

export async function parseCsv(filePath) {
  return parseCsvText(await Deno.readTextFile(filePath));
}
