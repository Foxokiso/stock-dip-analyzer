import { useEffect, useEffectEvent } from 'react';

// Desk auto-refresh that pauses while the window is hidden (minimised or fully
// covered). Chromium throttles timers in a hidden window but never stops a
// minute-scale interval, so every desk kept polling providers that rate-limit
// with nobody looking. A tick that falls due while the window is hidden is
// skipped; when the window is shown again, one catch-up call runs and the
// interval restarts from it, so the desk is at most one interval out of date
// and does not refresh twice in quick succession.

/**
 * Calls `callback` every `minutes` while `doc.visibilityState` is not 'hidden'.
 * With `whileHidden` it keeps running while hidden, so nothing is ever missed.
 * `minutes <= 0` schedules nothing. Returns a function that clears the interval
 * and the visibilitychange listener. `doc` and `timers` are injectable for tests.
 */
export function startVisibleInterval(callback, minutes, { whileHidden = false, doc = globalThis.document, timers = globalThis } = {}) {
    if (!(minutes > 0)) return () => {};
    const ms = minutes * 60_000;
    const hidden = () => doc.visibilityState === 'hidden';
    let missed = false;
    const tick = () => {
        if (!whileHidden && hidden()) {
            missed = true;
            return;
        }
        callback();
    };
    let timer = timers.setInterval(tick, ms);
    const onVisibilityChange = () => {
        if (!missed || hidden()) return;
        missed = false;
        timers.clearInterval(timer);
        timer = timers.setInterval(tick, ms);
        callback();
    };
    doc.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
        timers.clearInterval(timer);
        doc.removeEventListener('visibilitychange', onVisibilityChange);
    };
}

/**
 * startVisibleInterval for a component. Each tick runs the latest `callback`;
 * only a change of `minutes`, `whileHidden` or `resetKey` restarts the interval.
 * Pass the refresh target as `resetKey` when a new target is fetched as soon as
 * it is picked, so the old schedule does not fetch it again moments later.
 * Desks whose fetch lives inside an effect call startVisibleInterval from that
 * effect instead, so the timer stops with the fetch it drives.
 */
export function useVisibleInterval(callback, minutes, { whileHidden = false, resetKey } = {}) {
    const onTick = useEffectEvent(callback);
    // resetKey is a dependency only: the callback reads the current target itself.
    useEffect(() => startVisibleInterval(() => onTick(), minutes, { whileHidden }), [minutes, whileHidden, resetKey]);
}
