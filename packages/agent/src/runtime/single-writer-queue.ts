export class SingleWriterQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const runTask = this.tail.then(task, task);
    this.tail = runTask.then(
      () => {},
      () => {},
    );
    return runTask;
  }

  async waitForIdle(): Promise<void> {
    await this.tail;
  }
}
