export class Cache {
  private map = new Map<string, unknown>();

  constructor(private max: number) {}

  get(key: string): unknown {
    return this.map.get(key);
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}
