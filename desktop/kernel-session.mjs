// Serializes ownership changes so stop/start/exit cannot restore DNS out of order.
export class KernelSession {
  constructor(deps) {
    this.deps = deps;
    this.child = null;
    this.dnsTaken = false;
    this.queue = Promise.resolve();
    this.running = false;
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  start(tun) {
    return this.serial(async () => {
      if (this.running) return;
      try {
        this.child = await this.deps.launch();
        this.child.onExit(() => {
          this.running = false;
          void this.stop().catch((e) => this.deps.onError?.(e));
        });
        await this.deps.ready(this.child);
        if (tun) {
          this.dnsTaken = true;
          await this.deps.applyDns();
        }
        this.running = true;
      } catch (e) {
        await this.cleanup();
        throw e;
      }
    });
  }
  async cleanup() {
    this.running = false;
    if (this.child) {
      await this.child.stop();
      this.child = null;
    }
    if (this.dnsTaken) {
      await this.deps.restoreDns();
      this.dnsTaken = false;
    }
  }
  stop() {
    return this.serial(() => this.cleanup());
  }
}
