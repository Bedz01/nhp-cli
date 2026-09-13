import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  CONFIG_FILE,
  CREDENTIALS_FILE,
  configPath,
  deleteCredentials,
  dpapiProtect,
  dpapiUnprotect,
  loadSettings,
  resolveConfigDir,
  resolveCredentials,
  saveCredentials,
  saveSettings,
} from "../store.js";

const sep = Deno.build.os === "windows" ? "\\" : "/";
const isWindows = Deno.build.os === "windows";

// Points the store at a throwaway directory for the duration of `fn`. The
// legacy fallback (credentials.json next to the module) is still live, so
// these tests only assert on what they put in the temp dir themselves.
async function withTempConfigDir(fn) {
  const dir = await Deno.makeTempDir({ prefix: "nhp-store-test-" });
  const previous = Deno.env.get("NHP_CONFIG_DIR");
  Deno.env.set("NHP_CONFIG_DIR", dir);
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) Deno.env.delete("NHP_CONFIG_DIR");
    else Deno.env.set("NHP_CONFIG_DIR", previous);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resolveConfigDir: explicit override, APPDATA on Windows, XDG, then ~/.config", () => {
  assertEquals(resolveConfigDir({ NHP_CONFIG_DIR: "D:/tools/nhp-state/", APPDATA: "C:\\a" }, "windows"), "D:\\tools\\nhp-state", "override wins; slashes folded, trailing one dropped");
  assertEquals(resolveConfigDir({ NHP_CONFIG_DIR: "/x/y" }, "linux"), "/x/y");
  assertEquals(resolveConfigDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "windows"), "C:\\Users\\u\\AppData\\Roaming\\nhp");
  assertEquals(resolveConfigDir({ APPDATA: "C:/Users/u/AppData/Roaming" }, "windows"), "C:\\Users\\u\\AppData\\Roaming\\nhp", "forward slashes in APPDATA are folded");
  assertEquals(resolveConfigDir({ XDG_CONFIG_HOME: "/home/u/.cfg" }, "linux"), "/home/u/.cfg/nhp");
  assertEquals(resolveConfigDir({ HOME: "/home/u" }, "linux"), "/home/u/.config/nhp");
  assertEquals(resolveConfigDir({ HOME: "/home/u/" }, "darwin"), "/home/u/.config/nhp", "trailing slash on HOME is dropped");
  assertEquals(resolveConfigDir({ APPDATA: "C:\\a", HOME: "/home/u" }, "linux"), "/home/u/.config/nhp", "APPDATA is ignored off Windows");
  assertEquals(resolveConfigDir({ USERPROFILE: "C:\\Users\\u" }, "windows"), "C:\\Users\\u\\.config\\nhp", "no APPDATA falls back to the profile");
  assertThrows(() => resolveConfigDir({}, "linux"), Error, "NHP_CONFIG_DIR");
});

Deno.test("credentials: environment variables win over the stored file", async () => {
  await withTempConfigDir(async () => {
    await saveCredentials({ username: "stored@example.com", password: "stored" }, { encrypt: false });
    const creds = await resolveCredentials({ NHP_USERNAME: "env@example.com", NHP_PASSWORD: "env" });
    assertEquals(creds, { username: "env@example.com", password: "env", source: "env" });
  });
});

Deno.test("credentials: a plain stored file round-trips and reports its source and path", async () => {
  await withTempConfigDir(async () => {
    const saved = await saveCredentials({ username: "stored@example.com", password: "s3cret" }, { encrypt: false });
    assertEquals(saved.encrypted, false);
    assertEquals(saved.path, configPath(CREDENTIALS_FILE));
    const creds = await resolveCredentials({});
    assertEquals(creds.username, "stored@example.com");
    assertEquals(creds.password, "s3cret");
    assertEquals(creds.source, "store");
    assertEquals(creds.path, saved.path);
    assertEquals(await deleteCredentials(), true);
    assertEquals(await deleteCredentials(), false, "second delete finds nothing");
  });
});

Deno.test({
  name: "credentials: on Windows the password is stored as a DPAPI blob and decrypts on read",
  ignore: !isWindows,
  fn: async () => {
    await withTempConfigDir(async () => {
      const password = "pässwörd 123 $`\"'\\";
      const saved = await saveCredentials({ username: "u@example.com", password });
      assertEquals(saved.encrypted, true, saved.warning ?? "");
      const raw = await Deno.readTextFile(saved.path);
      assert(!raw.includes(password), "plaintext password must not be in the file");
      const json = JSON.parse(raw);
      assert(/^[A-Za-z0-9+/]{40,}={0,2}$/.test(json.password.dpapi), "password field is a base64 DPAPI blob");
      const creds = await resolveCredentials({});
      assertEquals(creds.password, password);
      assertEquals(creds.source, "store");
    });
  },
});

Deno.test({
  name: "dpapiProtect/dpapiUnprotect round-trip unicode and shell-hostile characters",
  ignore: !isWindows,
  fn: async () => {
    const text = "möney $(rm -rf /) `whoami` \"quoted\" 'single' \t tab";
    const blob = await dpapiProtect(text);
    assert(blob.startsWith("AQAAANCMnd8"), "base64 of the DPAPI 01000000 d08c9ddf header");
    assertEquals(await dpapiUnprotect(blob), text);
  },
});

Deno.test("settings: config.json is read, env overrides, saveSettings merges", async () => {
  await withTempConfigDir(async (dir) => {
    await Deno.writeTextFile(`${dir}${sep}${CONFIG_FILE}`, JSON.stringify({ sellMarginMultiplier: 1.25, other: "kept" }));
    assertEquals((await loadSettings({})).sellMarginMultiplier, 1.25);
    assertEquals((await loadSettings({ NHP_SELL_MARGIN: "1.5" })).sellMarginMultiplier, 1.5);
    assertEquals((await loadSettings({ NHP_SELL_MARGIN: "abc" })).sellMarginMultiplier, null, "unparseable env margin disables the margin");
    await saveSettings({ sellMarginMultiplier: 2 });
    const json = JSON.parse(await Deno.readTextFile(`${dir}${sep}${CONFIG_FILE}`));
    assertEquals(json, { sellMarginMultiplier: 2, other: "kept" });
  });
});
