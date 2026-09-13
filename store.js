// Where the CLI keeps its state, and how credentials are stored.
//
// Everything lives in a per-user config directory, never in the checkout:
//
//   NHP_CONFIG_DIR                      explicit override (tests, odd setups)
//   %APPDATA%\nhp                       Windows
//   $XDG_CONFIG_HOME/nhp                Linux/macOS when XDG is set
//   ~/.config/nhp                       otherwise
//
// Files:  config.json       { sellMarginMultiplier }
//         credentials.json  { username, password }  - see saveCredentials
//         cookies.json      the portal session (CookieJar format)
//
// The old location (the same names next to the module) is still read as a
// fallback so an upgrade keeps working; `nhp login` migrates it.
//
// Credentials on Windows are encrypted with DPAPI, scoped to the current
// Windows user on this machine, through a short PowerShell script - no
// native code, and the password only ever crosses to PowerShell on stdin,
// never on a command line. Elsewhere they are a plain file with mode 600.

import { fromFileUrl } from "jsr:@std/path@^1/from-file-url";

const TOOL     = "nhp";
const ENV_DIR  = "NHP_CONFIG_DIR";
const ENV_USER = "NHP_USERNAME";
const ENV_PASS = "NHP_PASSWORD";

export const CONFIG_FILE      = "config.json";
export const CREDENTIALS_FILE = "credentials.json";
export const SESSION_FILE     = "cookies.json";

// Joins with the OS separator; on Windows any forward slashes are folded
// into backslashes so a dir given either way prints consistently.
function joinPath(os, ...parts) {
  const sep = os === "windows" ? "\\" : "/";
  const joined = parts.map((p, i) => i === 0 ? p.replace(/[\\/]+$/, "") : p).join(sep);
  return os === "windows" ? joined.replace(/\//g, "\\") : joined;
}

// Pure: takes the environment and OS so tests can pin every branch.
export function resolveConfigDir(env = Deno.env.toObject(), os = Deno.build.os) {
  if (env[ENV_DIR]) return joinPath(os, env[ENV_DIR]);
  if (os === "windows" && env.APPDATA) return joinPath(os, env.APPDATA, TOOL);
  if (env.XDG_CONFIG_HOME) return joinPath(os, env.XDG_CONFIG_HOME, TOOL);
  const home = env.HOME || env.USERPROFILE;
  if (home) return joinPath(os, home, ".config", TOOL);
  throw new Error(`Cannot work out a config directory; set ${ENV_DIR}.`);
}

export function configDir() { return resolveConfigDir(); }
export function configPath(name) { return joinPath(Deno.build.os, configDir(), name); }
// The pre-1.4 location: next to the module, as a plain path so it prints well.
export function legacyPath(name) { return fromFileUrl(new URL(name, import.meta.url)); }

export async function ensureConfigDir() {
  const dir = configDir();
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

async function readJson(path) {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw new Error(`Cannot read ${path}: ${err.message}`);
  }
}

async function removeIfPresent(path) {
  try {
    await Deno.remove(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function fileExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DPAPI through PowerShell, calling .NET's ProtectedData directly rather than
// ConvertFrom-SecureString: the cmdlet needs the Microsoft.PowerShell.Security
// module, which can fail to load on an otherwise healthy machine, while the
// .NET call has no such dependency. The blob is base64 of DPAPI over the
// UTF-8 bytes, CurrentUser scope, and either PowerShell can decrypt what
// the other produced. Windows PowerShell 5.1 is tried first (always present,
// quicker to start), then pwsh. Each script exits 1 on any failure and the
// output is checked, so a half-working shell cannot pass for success.
// ---------------------------------------------------------------------------
const PS_PRELUDE = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8
$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser`;

const PS_PROTECT = `${PS_PRELUDE}
try {
  $s=[Console]::In.ReadToEnd().TrimEnd("\`r","\`n")
  $p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, $scope)
  [Console]::Out.Write([Convert]::ToBase64String($p))
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;

const PS_UNPROTECT = `${PS_PRELUDE}
try {
  $p=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $b=[Security.Cryptography.ProtectedData]::Unprotect($p, $null, $scope)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;

async function runPowerShell(script, stdinText) {
  let lastError = "no PowerShell found (tried powershell.exe, pwsh)";
  for (const exe of ["powershell.exe", "pwsh"]) {
    let child;
    try {
      child = new Deno.Command(exe, {
        args: ["-NoProfile", "-NonInteractive", "-Command", script],
        stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinText));
    await writer.close();
    const out = await child.output();
    if (out.success) return new TextDecoder().decode(out.stdout);
    lastError = `${exe}: ${new TextDecoder().decode(out.stderr).trim().split(/\r?\n/)[0] || `exit ${out.code}`}`;
  }
  throw new Error(lastError);
}

export async function dpapiProtect(text) {
  const blob = (await runPowerShell(PS_PROTECT, text + "\n")).trim();
  if (!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(blob)) throw new Error("PowerShell returned something that is not a DPAPI blob");
  return blob;
}

export async function dpapiUnprotect(blob) {
  return await runPowerShell(PS_UNPROTECT, blob + "\n");
}

// ---------------------------------------------------------------------------
// Credentials. Precedence: environment, then the stored file, then the old
// module-relative file. `source` says which, so callers can explain
// themselves ("Logging in as x (from NHP_USERNAME)").
// ---------------------------------------------------------------------------
async function readCredentialsFile(path, source) {
  const json = await readJson(path);
  if (!json || !json.username || json.password === undefined || json.password === null) return null;
  let password = json.password;
  if (typeof password === "object") {
    if (typeof password.dpapi !== "string") throw new Error(`${path}: unrecognised password format`);
    try {
      password = await dpapiUnprotect(password.dpapi);
    } catch (err) {
      throw new Error(`Cannot decrypt the stored password (${err.message}). Run 'nhp login --reset' to enter it again.`);
    }
  }
  return { username: json.username, password, source, path: String(path) };
}

export async function resolveCredentials(env = Deno.env.toObject()) {
  if (env[ENV_USER] && env[ENV_PASS]) return { username: env[ENV_USER], password: env[ENV_PASS], source: "env" };
  return (await readCredentialsFile(configPath(CREDENTIALS_FILE), "store"))
      ?? (await readCredentialsFile(legacyPath(CREDENTIALS_FILE), "legacy"));
}

// Cheap presence check (no decryption) for deciding whether to prompt.
export async function hasCredentials(env = Deno.env.toObject()) {
  if (env[ENV_USER] && env[ENV_PASS]) return true;
  return (await fileExists(configPath(CREDENTIALS_FILE))) || (await fileExists(legacyPath(CREDENTIALS_FILE)));
}

// Writes credentials.json in the config dir. On Windows the password is a
// DPAPI blob unless `encrypt` is false or no PowerShell can do it (then it is
// plain text and the result carries a warning). Returns { path, encrypted, warning }.
export async function saveCredentials({ username, password }, { encrypt = Deno.build.os === "windows" } = {}) {
  await ensureConfigDir();
  const path = configPath(CREDENTIALS_FILE);
  let stored = password, encrypted = false, warning = null;
  if (encrypt) {
    try {
      stored = { dpapi: await dpapiProtect(password) };
      encrypted = true;
    } catch (err) {
      warning = `DPAPI encryption unavailable (${err.message}); storing the password as plain text.`;
    }
  }
  await Deno.writeTextFile(path, JSON.stringify({ username, password: stored }, null, 2) + "\n", { mode: 0o600 });
  return { path, encrypted, warning };
}

export async function deleteCredentials() { return await removeIfPresent(configPath(CREDENTIALS_FILE)); }
export async function deleteSession()     { return await removeIfPresent(configPath(SESSION_FILE)); }

// ---------------------------------------------------------------------------
// Non-secret settings: config.json in the config dir, else the old
// credentials.json (which used to hold the margin too), env override last.
// ---------------------------------------------------------------------------
export async function loadSettings(env = Deno.env.toObject()) {
  const settings = { sellMarginMultiplier: null };
  const json = (await readJson(configPath(CONFIG_FILE))) ?? (await readJson(legacyPath(CREDENTIALS_FILE)));
  if (json && json.sellMarginMultiplier !== undefined) settings.sellMarginMultiplier = json.sellMarginMultiplier;
  if (env.NHP_SELL_MARGIN !== undefined) {
    const margin = parseFloat(env.NHP_SELL_MARGIN);
    settings.sellMarginMultiplier = isNaN(margin) ? null : margin;
  }
  return settings;
}

export async function saveSettings(settings) {
  await ensureConfigDir();
  const path = configPath(CONFIG_FILE);
  const current = (await readJson(path)) ?? {};
  await Deno.writeTextFile(path, JSON.stringify({ ...current, ...settings }, null, 2) + "\n");
  return path;
}
