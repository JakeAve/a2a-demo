// A serialised FIFO. enqueue() returns immediately; a single consumer drains
// the queue one item at a time so an agent never runs two room-turns at once.
export class InboxQueue<T> {
  #queue: T[] = [];
  #running = false;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | null = null;

  constructor(private process: (item: T) => Promise<void>) {}

  enqueue(item: T): void {
    this.#queue.push(item);
    if (!this.#running) {
      this.#idle = new Promise((res) => {
        this.#resolveIdle = res;
      });
      this.#running = true;
      void this.#loop();
    }
  }

  async #loop(): Promise<void> {
    while (this.#queue.length) {
      const item = this.#queue.shift()!;
      try {
        await this.process(item);
      } catch { /* a wedged turn must not kill the loop */ }
    }
    this.#running = false;
    this.#resolveIdle?.();
    this.#resolveIdle = null;
  }

  // Resolves when the queue has fully drained (for tests/shutdown).
  drain(): Promise<void> {
    return this.#running ? this.#idle : Promise.resolve();
  }
}
