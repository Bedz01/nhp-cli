export class Logger {
  constructor(options = {}) {
    this.isJson = options.isJson || false;
    this.verbose = options.verbose || false;
  }

  log(...args) {
    if (!this.isJson) console.log(...args);
  }

  debug(...args) {
    if (!this.isJson && this.verbose) {
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
}
