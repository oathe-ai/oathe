// oathe — the drift lanes' ONE report: named checks in order, one render, one exit code, the
// trailer voice every oathe verb speaks (`<lane>: <harness> ok (<version>)` or
// `<lane>: <harness> FAILED — <check>: <detail>`). A lane fails loud by naming the check.

export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;

export class LaneReport {
  constructor({ lane, harness, version = null }) {
    this.lane = lane;
    this.harness = harness;
    this.version = version;
    this.checks = [];
  }

  add(name, ok, detail = '') {
    this.checks.push({ name, ok, detail });
    return ok;
  }

  get ok() {
    return this.checks.every((c) => c.ok);
  }

  get exitCode() {
    return this.ok ? 0 : EXIT_FAILED;
  }

  render() {
    const lines = this.checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    const first = this.checks.find((c) => !c.ok);
    lines.push(this.ok
      ? `${this.lane}: ${this.harness} ok${this.version ? ` (${this.version})` : ''}`
      : `${this.lane}: ${this.harness} FAILED — ${first.name}: ${first.detail}`);
    return `${lines.join('\n')}\n`;
  }
}
