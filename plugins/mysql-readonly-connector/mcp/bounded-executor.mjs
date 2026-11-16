export class BoundedExecutor {
  constructor({ maxActive, maxQueued, queueTimeoutMs }) {
    this.maxActive = maxActive;
    this.maxQueued = maxQueued;
    this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0;
    this.queue = [];
    this.closed = false;
  }

  run(task) {
    if (this.closed) return Promise.reject(new Error("查询执行器已经关闭。"));
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, timer: null };
      if (this.active < this.maxActive) {
        this.start(entry);
        return;
      }
      if (this.queue.length >= this.maxQueued) {
        reject(new Error("查询请求过多，等待队列已满，请稍后重试。"));
        return;
      }
      entry.timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("查询在等待连接时超时，请稍后重试。"));
      }, this.queueTimeoutMs);
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  start(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    this.active += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }

  drain() {
    while (!this.closed && this.active < this.maxActive && this.queue.length > 0) {
      this.start(this.queue.shift());
    }
  }

  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("MCP 服务正在关闭，排队查询已取消。"));
    }
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length };
  }
}
