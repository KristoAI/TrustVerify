/** Bound browser/library work without pretending an uncancellable task stopped. */
export function bounded<T>(work: PromiseLike<T>, signal: AbortSignal | undefined, milliseconds: number, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const abort = () => fail(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => fail(new Error('OPERATION_TIMEOUT')), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then((value) => {
      if (settled) { late?.(value); return; }
      settled = true; cleanup(); resolve(value);
    }, fail);
    if (signal?.aborted) abort();
  });
}
