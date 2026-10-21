// Small concurrency helpers shared by the market-data desks.
//
// mapPool  — run a worker over a fixed list with a bounded number in flight,
//            results in input order, each one reported as it lands.
// createQueue / drainQueue — a producer/consumer pair for streams whose items
//            arrive over time (screener pages feeding score hydration).

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency  maximum workers in flight (>= 1)
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{ onSettled?: (index: number, result: R, item: T) => void, shouldStop?: () => boolean }} [options]
 *   onSettled fires per item as soon as it resolves (out of order);
 *   shouldStop is consulted before each new item so a superseded run stops pulling work.
 * @returns {Promise<R[]>} results in input order; undefined for items never started.
 * The first worker error is rethrown after the other in-flight workers finish.
 */
export async function mapPool(items, concurrency, worker, { onSettled, shouldStop } = {}) {
    const results = new Array(items.length);
    let next = 0;
    let failure = null;
    const run = async () => {
        while (next < items.length && !failure && !shouldStop?.()) {
            const index = next++;
            try {
                const result = await worker(items[index], index);
                results[index] = result;
                onSettled?.(index, result, items[index]);
            } catch (error) {
                failure ??= error;
            }
        }
    };
    const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
    await Promise.all(Array.from({ length: width }, run));
    if (failure) throw failure;
    return results;
}

/** An unbounded FIFO whose consumers await new items until it is closed. */
export function createQueue() {
    const items = [];
    const waiters = [];
    let closed = false;
    const wake = () => waiters.splice(0).forEach(resolve => resolve());
    return {
        push(...values) {
            if (closed) return;
            items.push(...values);
            wake();
        },
        close() {
            closed = true;
            wake();
        },
        get size() { return items.length; },
        get closed() { return closed; },
        /** Resolves with the next item, or undefined once the queue is closed and empty. */
        async take() {
            while (items.length === 0) {
                if (closed) return undefined;
                await new Promise(resolve => waiters.push(resolve));
            }
            return items.shift();
        },
    };
}

/**
 * Consume a queue with `concurrency` workers until it is closed and empty.
 * Worker errors are collected and the first one rethrown at the end, so one
 * failing symbol never stops the rest of the stream.
 */
export async function drainQueue(queue, concurrency, worker, { shouldStop } = {}) {
    let failure = null;
    const run = async () => {
        while (!shouldStop?.()) {
            const item = await queue.take();
            if (item === undefined) return;
            try { await worker(item); } catch (error) { failure ??= error; }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.floor(concurrency) || 1) }, run));
    if (failure) throw failure;
}
