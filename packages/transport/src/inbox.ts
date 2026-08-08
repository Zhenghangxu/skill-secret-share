export class AsyncInbox<T> {
  private values: T[] = [];
  private waiters: Array<{ resolve: (value: T) => void; reject: (error: Error) => void }> = [];
  private error: Error | null = null;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  fail(error: Error): void {
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(timeoutMs = 30_000): Promise<T> {
    if (this.values.length > 0) return this.values.shift()!;
    if (this.error) throw this.error;
    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for peer'));
      }, timeoutMs);
      timeout.unref();
      waiter.resolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });
  }
}
