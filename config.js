export async function loadConfig() {
  const config = { sellMarginMultiplier: null };
  try {
    const configUrl = new URL("credentials.json", import.meta.url);
    const text = await Deno.readTextFile(configUrl);
    const json = JSON.parse(text);
    if (json.sellMarginMultiplier !== undefined) {
      config.sellMarginMultiplier = json.sellMarginMultiplier;
    }
  } catch {
    // Ignore if not present
  }
  const marginEnv = Deno.env.get("NHP_SELL_MARGIN");
  if (marginEnv !== undefined && marginEnv !== null) {
    const margin = parseFloat(marginEnv);
    config.sellMarginMultiplier = isNaN(margin) ? null : margin;
  }
  return config;
}

export async function loadCredentials() {
  try {
    const credsUrl = new URL("credentials.json", import.meta.url);
    const text = await Deno.readTextFile(credsUrl);
    const json = JSON.parse(text);
    if (json.username && json.password) {
      return { username: json.username, password: json.password };
    }
  } catch {
    // Ignore, try env vars next
  }

  const usernameEnv = Deno.env.get("NHP_USERNAME");
  const passwordEnv = Deno.env.get("NHP_PASSWORD");
  if (usernameEnv && passwordEnv) {
    return { username: usernameEnv, password: passwordEnv };
  }

  throw new Error("Credentials not found. Please configure 'credentials.json' or set NHP_USERNAME and NHP_PASSWORD env variables.");
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
