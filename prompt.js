// Terminal prompts for `nhp login`. The password is read with the terminal
// in raw mode so nothing is echoed; the byte handling is a small state
// machine (HiddenLineReader) so it can be tested without a TTY.

export class HiddenLineReader {
  constructor() {
    this.bytes = [];
    this.done = false;
    this.interrupted = false;
    this.eof = false;
  }

  // Feed raw bytes; returns true once a full line has been read (or the
  // input was interrupted / closed). Enter arrives as \r in raw mode.
  feed(chunk) {
    for (const b of chunk) {
      if (this.done) break;
      if (b === 0x03) { this.interrupted = true; this.done = true; }                          // Ctrl-C
      else if (b === 0x04 && this.bytes.length === 0) { this.eof = true; this.done = true; } // Ctrl-D, empty line
      else if (b === 0x0d || b === 0x0a) this.done = true;                                     // Enter
      else if (b === 0x7f || b === 0x08) this._backspace();
      else if (b >= 0x20) this.bytes.push(b);                                                  // printable or UTF-8
    }
    return this.done;
  }

  // Drop one code point: continuation bytes (10xxxxxx) then the lead byte.
  _backspace() {
    while (this.bytes.length > 0) {
      const b = this.bytes.pop();
      if ((b & 0xc0) !== 0x80) break;
    }
  }

  get line() {
    return new TextDecoder().decode(new Uint8Array(this.bytes));
  }
}

export function isInteractive() {
  return Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
}

export function promptLine(label) {
  const answer = prompt(label);
  if (answer === null) throw new Error("Input closed.");
  return answer.trim();
}

export async function promptHidden(label) {
  const enc = new TextEncoder();
  await Deno.stdout.write(enc.encode(label + " "));
  const reader = new HiddenLineReader();
  const buf = new Uint8Array(64);
  Deno.stdin.setRaw(true);
  try {
    while (!reader.done) {
      const n = await Deno.stdin.read(buf);
      if (n === null) { reader.eof = true; break; }
      reader.feed(buf.subarray(0, n));
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stdout.write(enc.encode("\n"));
  }
  if (reader.interrupted) Deno.exit(130);
  if (reader.eof) throw new Error("Input closed.");
  return reader.line;
}

// Asks for both and returns { username, password }. Empty answers re-ask;
// an empty username accepts the default when one is offered.
export async function promptCredentials(defaults = {}) {
  let username = "";
  while (!username) {
    username = promptLine(defaults.username ? `Username [${defaults.username}]:` : "Username:");
    if (!username && defaults.username) username = defaults.username;
  }
  let password = "";
  while (!password) password = await promptHidden("Password:");
  return { username, password };
}
