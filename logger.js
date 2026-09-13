export class Logger {
  constructor(options = {}) {
    this.isJson = options.isJson || false;
    this.isTsv = options.isTsv || false;
    this.verbose = options.verbose || false;
  }

  // Human-facing chatter: progress lines and the formatted views. Silent in
  // both machine modes (--json, --tsv) so stdout carries only the payload.
  log(...args) {
    if (!this.isJson && !this.isTsv) console.log(...args);
  }

  debug(...args) {
    if (!this.isJson && !this.isTsv && this.verbose) {
      console.log(...args);
    }
  }

  error(...args) {
    // Errors output to stderr even in JSON mode, so stdout JSON remains valid
    console.error(...args);
  }

  warn(...args) {
    if (!this.isJson) console.warn(...args);
  }

  json(data) {
    if (this.isJson) {
      console.log(JSON.stringify(data, null, 2));
    }
  }

  // One --tsv payload row. --json wins over --tsv.
  tsv(line) {
    if (this.isTsv && !this.isJson) console.log(line);
  }
}
