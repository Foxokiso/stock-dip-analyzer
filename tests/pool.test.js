import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPool, createQueue, drainQueue, createLimiter } from '../src/utils/pool.js';

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

test('createLimiter never exceeds its width and serves the highest priority first, then arrival order', async () => {
    const limiter = createLimiter(2);
    const started = [];
    const finish = new Map();
    const task = (name) => () => { started.push(name); return new Promise(resolve => finish.set(name, () => resolve(name))); };
    const runs = [['a1', 1], ['a2', 1], ['a3', 1], ['b1', 2], ['a4', 1], ['c1', 3], ['b2', 2]].map(([name, priority]) => limiter.run(task(name), priority));
    await tick();
    assert.deepEqual(started, ['a1', 'a2']);
    assert.equal(limiter.waiting, 5);
    for (const name of ['a1', 'a2', 'c1', 'b1', 'b2', 'a3', 'a4']) {
        finish.get(name)();
        await tick();
        assert.ok(limiter.active <= 2, `${limiter.active} running`);
    }
    assert.deepEqual(started, ['a1', 'a2', 'c1', 'b1', 'b2', 'a3', 'a4']);
    assert.deepEqual(await Promise.all(runs), ['a1', 'a2', 'a3', 'b1', 'a4', 'c1', 'b2']);
    assert.equal(limiter.active, 0);
});

test('createLimiter reads a priority function when a slot frees, so a waiting task can be promoted', async () => {
    const limiter = createLimiter(1);
    const started = [];
    let promoted = 1;
    const holding = limiter.run(tick);
    const runs = [limiter.run(async () => started.push('fixed'), 2), limiter.run(async () => started.push('promoted'), () => promoted)];
    promoted = 3;
    await Promise.all([holding, ...runs]);
    assert.deepEqual(started, ['promoted', 'fixed']);
    assert.equal(limiter.active, 0);
});

test('createLimiter hands the slot on when a task fails', async () => {
    const limiter = createLimiter(1);
    const failing = limiter.run(async () => { await tick(); throw new Error('boom'); });
    const next = limiter.run(async () => 'next');
    await assert.rejects(failing, /boom/);
    assert.equal(await next, 'next');
    assert.equal(limiter.active, 0);
});
