export async function loadConfig() {
  let config = { sellMarginMultiplier: null };
  try {
    const configUrl = new URL("credentials.json", import.meta.url);
    const text = await Deno.readTextFile(configUrl);
    const json = JSON.parse(text);
    if (json.sellMarginMultiplier !== undefined) {
      config.sellMarginMultiplier = json.sellMarginMultiplier;
    }
  } catch (err) {
    // Ignore if not present
  }
  const marginEnv = Deno.env.get("NHP_SELL_MARGIN");
  if (marginEnv !== undefined && marginEnv !== null) {
    config.sellMarginMultiplier = parseFloat(marginEnv);
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
  } catch (err) {
    // Ignore, try env vars next
  }

  const usernameEnv = Deno.env.get("NHP_USERNAME");
  const passwordEnv = Deno.env.get("NHP_PASSWORD");
  if (usernameEnv && passwordEnv) {
    return { username: usernameEnv, password: passwordEnv };
  }

  throw new Error("Credentials not found. Please configure 'credentials.json' or set NHP_USERNAME and NHP_PASSWORD env variables.");
}


export async function parseCsv(filePath) {
  const text = await Deno.readTextFile(filePath);
  const lines = text.split(/\r?\n/);
  const items = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const parts = trimmed.split(",");
    if (parts.length < 2) continue;
    
    const itemId = parts[0].replace(/['"]/g, "").trim();
    const qty = parseInt(parts[1].trim(), 10);
    
    if (itemId && !isNaN(qty)) {
      items.push({ itemId, qty });
    }
  }
  return items;
}
