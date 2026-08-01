export type KeyedTaskResult<T> =
  | { started: false }
  | { started: true; value: T };

/**
 * Tracks independent async actions by key while rejecting duplicate work for
 * a key that is already pending. Every completion owns its callback, unlike a
 * mutation observer whose per-call callbacks can be replaced by a later call.
 */
export class KeyedTaskGate {
  private readonly pending = new Set<string>();

  snapshot(): Set<string> {
    return new Set(this.pending);
  }

  async run<T>(
    key: string,
    task: () => Promise<T>,
    onPendingChange: (pending: Set<string>) => void,
  ): Promise<KeyedTaskResult<T>> {
    if (this.pending.has(key)) return { started: false };

    this.pending.add(key);
    onPendingChange(this.snapshot());

    try {
      return { started: true, value: await task() };
    } finally {
      this.pending.delete(key);
      onPendingChange(this.snapshot());
    }
  }
}
