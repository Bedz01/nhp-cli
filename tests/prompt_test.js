import { assert, assertEquals } from "jsr:@std/assert@^1";
import { HiddenLineReader } from "../prompt.js";

const bytes = (s) => new TextEncoder().encode(s);

Deno.test("hidden input: Enter (\\r in raw mode) ends the line, text before it is kept", () => {
  const r = new HiddenLineReader();
  assertEquals(r.feed(bytes("hunter2")), false);
  assertEquals(r.feed(bytes("\r")), true);
  assertEquals(r.line, "hunter2");
  assert(!r.interrupted && !r.eof);
});

Deno.test("hidden input: arrives in arbitrary chunks and \\n also ends it", () => {
  const r = new HiddenLineReader();
  r.feed(bytes("ab"));
  r.feed(bytes("c"));
  assertEquals(r.feed(bytes("\nignored")), true);
  assertEquals(r.line, "abc");
});

Deno.test("hidden input: backspace removes one code point, including multi-byte ones", () => {
  const r = new HiddenLineReader();
  r.feed(bytes("pä"));
  r.feed(new Uint8Array([0x7f]));          // DEL
  r.feed(bytes("a"));
  r.feed(new Uint8Array([0x08]));          // BS
  r.feed(bytes("ss\r"));
  assertEquals(r.line, "pss");
  const empty = new HiddenLineReader();
  empty.feed(new Uint8Array([0x7f, 0x7f, 0x0d]));
  assertEquals(empty.line, "", "backspace on an empty line is a no-op");
});

Deno.test("hidden input: Ctrl-C interrupts, Ctrl-D on an empty line is EOF, control bytes are dropped", () => {
  const c = new HiddenLineReader();
  assertEquals(c.feed(bytes("abc\x03")), true);
  assert(c.interrupted);

  const d = new HiddenLineReader();
  assertEquals(d.feed(new Uint8Array([0x04])), true);
  assert(d.eof);

  const notEof = new HiddenLineReader();
  notEof.feed(bytes("x\x04y\r"));
  assertEquals(notEof.line, "xy", "Ctrl-D mid-line is ignored");
  assert(!notEof.eof);

  const ctl = new HiddenLineReader();
  ctl.feed(new Uint8Array([0x1b, 0x5b, 0x41, 0x61, 0x0d]));  // ESC [ A a
  assertEquals(ctl.line, "[Aa", "ESC is dropped; printable bytes stay");
});
