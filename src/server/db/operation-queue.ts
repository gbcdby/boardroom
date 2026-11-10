/** 一个事务内的操作按顺序执行；子事务整体排队，其内部另有自己的队列。 */
export class OperationQueue {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  readonly parent: OperationQueue | undefined;

  constructor(parent?: OperationQueue) { this.parent = parent; }

  /** 捕获的祖先事务句柄在子事务中使用时，应重入当前子作用域。 */
  isWithin(ancestor: OperationQueue): boolean {
    for (let scope: OperationQueue | undefined = this; scope; scope = scope.parent) {
      if (scope === ancestor) return true;
    }
    return false;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("事务作用域已结束，不能继续使用其连接。"));
    const result = this.pending.then(operation);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  async drain(): Promise<void> { await this.pending; }
  close(): void { this.closed = true; }
}
