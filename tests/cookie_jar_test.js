import { assert, assertEquals } from "jsr:@std/assert@^1";
import { CookieJar } from "../cookie-jar.js";

Deno.test("accepts cookies and builds a Cookie header", () => {
  const jar = new CookieJar();
  jar.acceptCookies(new Headers([
    ["set-cookie", "session=abc123; Path=/; HttpOnly"],
    ["set-cookie", "pref=dark; Max-Age=3600"],
  ]));
  assertEquals(jar.get("session"), "abc123");
  assertEquals(jar.getCookieHeader(), "session=abc123; pref=dark");
});

Deno.test("an expired Set-Cookie deletes the cookie", () => {
  const jar = new CookieJar();
  jar.acceptCookies(new Headers([["set-cookie", "session=abc123; Path=/"]]));
  assert(jar.has("session"));
  jar.acceptCookies(new Headers([
    ["set-cookie", "session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/"],
  ]));
  assert(!jar.has("session"));
  assertEquals(jar.getCookieHeader(), "");
});

Deno.test("expired cookies are excluded from the header and lookups", () => {
  const jar = new CookieJar();
  jar.cookies.set("stale", { value: "old", expires: Date.now() - 1000 });
  jar.cookies.set("fresh", { value: "new", expires: Date.now() + 60000 });
  assertEquals(jar.get("stale"), undefined);
  assert(!jar.has("stale"));
  assertEquals(jar.getCookieHeader(), "fresh=new");
  assertEquals(jar.names(), ["fresh"]);
});

Deno.test("loads the legacy [name, value] file format", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify([["session", "legacyvalue"]]));
    const jar = new CookieJar();
    await jar.loadFromFile(path);
    assertEquals(jar.get("session"), "legacyvalue");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("save/load roundtrip preserves cookies and drops expired ones", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const jar = new CookieJar();
    jar.cookies.set("keep", { value: "yes", expires: Date.now() + 60000 });
    jar.cookies.set("drop", { value: "no", expires: Date.now() - 1000 });
    jar.cookies.set("session", { value: "nodate" });
    await jar.saveToFile(path);

    const loaded = new CookieJar();
    await loaded.loadFromFile(path);
    assertEquals(loaded.get("keep"), "yes");
    assertEquals(loaded.get("session"), "nodate");
    assert(!loaded.has("drop"));
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("a corrupt cookie file resets to an empty jar", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, "not json{{");
    const jar = new CookieJar();
    await jar.loadFromFile(path);
    assertEquals(jar.getCookieHeader(), "");
  } finally {
    await Deno.remove(path);
  }
});
