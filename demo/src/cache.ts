export class Cache {
  private map = new Map<string, unknown>();

  constructor(private max: number) {}

  get(key: string): unknown {
    return this.map.get(key);
  }

  set(key: string, value: unknown): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    console.log("cache set", key);
    this.map.set(key, value);
  }
}
