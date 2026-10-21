import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPool, createQueue, drainQueue } from '../src/utils/pool.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('mapPool keeps results in input order and never exceeds the concurrency', async () => {
    let inFlight = 0, peak = 0;
    const settled = [];
    const results = await mapPool([30, 5, 20, 1, 10], 2, async (delay, index) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, delay));
        inFlight--;
        return index * 10;
    }, { onSettled: index => settled.push(index) });
    assert.deepEqual(results, [0, 10, 20, 30, 40]);
    assert.equal(peak, 2);
    assert.equal(settled.length, 5);
    assert.notDeepEqual(settled, [0, 1, 2, 3, 4], 'items settle as they finish, not in order');
});

test('mapPool stops pulling new items once shouldStop reports a superseded run', async () => {
    let started = 0;
    let stop = false;
    const results = await mapPool([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started++;
        await tick();
        if (item === 2) stop = true;
        return item;
    }, { shouldStop: () => stop });
    assert.ok(started <= 4, `started ${started} items after the stop signal`);
    assert.equal(results[0], 1);
});

test('mapPool rethrows the first error after the other workers finish', async () => {
    const finished = [];
    await assert.rejects(mapPool([1, 2, 3, 4], 2, async (item) => {
        await tick();
        if (item === 1) throw new Error('boom');
        finished.push(item);
        return item;
    }), /boom/);
    assert.ok(finished.includes(2), 'the sibling in flight still completed');
    assert.ok(!finished.includes(4), 'no new items start after a failure');
});

test('queue consumers wait for late items and stop when it closes', async () => {
    const queue = createQueue();
    const seen = [];
    const drained = drainQueue(queue, 3, async (item) => { await tick(); seen.push(item); });
    queue.push('a', 'b');
    await tick(); await tick();
    queue.push('c');
    queue.close();
    await drained;
    assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
    assert.equal(await queue.take(), undefined);
    queue.push('ignored after close');
    assert.equal(queue.size, 0);
});

test('drainQueue collects a worker error without dropping the remaining items', async () => {
    const queue = createQueue();
    const done = [];
    queue.push(1, 2, 3);
    queue.close();
    await assert.rejects(drainQueue(queue, 1, async (item) => {
        if (item === 2) throw new Error('bad symbol');
        done.push(item);
    }), /bad symbol/);
    assert.deepEqual(done, [1, 3]);
});
