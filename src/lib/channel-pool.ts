/**
 * A pool of signing channels that hands each one to at most one holder at a
 * time (#249).
 *
 * A channel account is one sequence stream: two transactions built from the
 * same account at once would both take the same sequence number and one
 * would fail with `txBadSeq`. Every in-flight settlement therefore leases a
 * channel with {@link acquire} and gives it back with {@link release} when
 * its transaction is finished — settled, failed or timed out — and a caller
 * that finds every channel busy waits for the next release instead of
 * sharing one.
 *
 * Free channels are handed out least-recently-released first, so with fewer
 * workers than channels the fees spread over every account instead of
 * draining the first ones.
 */
export class ChannelPool<T> {
  private readonly free: T[];
  private readonly leased = new Set<T>();
  private readonly waiting: Array<(channel: T) => void> = [];

  constructor(channels: readonly T[]) {
    this.free = [...new Set(channels)];
  }

  /** Channels currently leased. */
  get inUse(): number {
    return this.leased.size;
  }

  /** Lease a free channel, waiting for a release when none is free. */
  acquire(): Promise<T> {
    const channel = this.free.shift();
    if (channel !== undefined) {
      this.leased.add(channel);
      return Promise.resolve(channel);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Return a leased channel; the longest waiter, if any, gets it next. */
  release(channel: T): void {
    if (!this.leased.has(channel)) {
      throw new Error("released a channel that is not leased");
    }
    const next = this.waiting.shift();
    if (next) {
      // Handed straight over: the channel stays leased, to the waiter now.
      next(channel);
      return;
    }
    this.leased.delete(channel);
    this.free.push(channel);
  }
}
