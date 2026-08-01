import { KeyedTaskGate } from '@/lib/keyed-task-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('KeyedTaskGate', () => {
  it('keeps distinct rapid actions independent and rejects duplicate work', async () => {
    const gate = new KeyedTaskGate();
    const first = deferred<string>();
    const second = deferred<string>();
    const pendingSnapshots: string[][] = [];
    const onPendingChange = (pending: Set<string>) => {
      pendingSnapshots.push([...pending].sort());
    };

    const firstRun = gate.run('movie-1', () => first.promise, onPendingChange);
    const duplicate = await gate.run(
      'movie-1',
      () => Promise.resolve('duplicate'),
      onPendingChange,
    );
    const secondRun = gate.run('movie-2', () => second.promise, onPendingChange);

    expect(duplicate).toEqual({ started: false });
    second.resolve('second');
    await expect(secondRun).resolves.toEqual({ started: true, value: 'second' });
    first.resolve('first');
    await expect(firstRun).resolves.toEqual({ started: true, value: 'first' });
    expect(pendingSnapshots).toEqual([
      ['movie-1'],
      ['movie-1', 'movie-2'],
      ['movie-1'],
      [],
    ]);
  });

  it('clears a failed key so it can be retried', async () => {
    const gate = new KeyedTaskGate();
    const failure = deferred<void>();
    const run = gate.run('movie-1', () => failure.promise, () => undefined);

    failure.reject(new Error('network failed'));
    await expect(run).rejects.toThrow('network failed');
    await expect(
      gate.run('movie-1', () => Promise.resolve('retried'), () => undefined),
    ).resolves.toEqual({ started: true, value: 'retried' });
    expect(gate.snapshot()).toEqual(new Set());
  });
});
