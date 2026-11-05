// A tiny async mutex: `run` calls go one after another, in the order they asked.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await before;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
