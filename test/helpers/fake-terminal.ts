import type { Terminal } from "@earendil-works/pi-tui";

/**
 * A headless Terminal.
 *
 * pi-tui does not export a virtual terminal, but the interface is small enough
 * to implement, and doing so lets the dashboard be rendered and asserted on in
 * CI without a TTY.
 */
export class FakeTerminal implements Terminal {
  readonly written: string[] = [];
  private onInput?: (data: string) => void;

  constructor(
    public columns = 100,
    public rows = 30,
  ) {}

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  /** Feed a keypress to the focused component. */
  send(data: string): void {
    this.onInput?.(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
  }
}
