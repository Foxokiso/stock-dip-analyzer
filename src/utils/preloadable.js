import { createElement } from 'react';

// Like React.lazy, but renders synchronously once the module has loaded. A page
// warmed with preload() during idle time therefore never shows the Suspense
// fallback, and never pays React 19's 300 ms fallback-reveal throttle, which
// otherwise delays every cold route switch by exactly that much.
//
// A failed import is not cached here: the next preload() or render imports
// again. Whether that can succeed is up to the browser: the Chromium that
// Electron 45 ships fetches a failed module again, while older Chromium fails
// the repeat import without fetching. A render that was waiting on the
// failed import throws its Error for the nearest error boundary instead;
// throwing the rejected promise again would make React re-render on it
// forever. That error stays until the next preload(), because React renders
// once more right after an error and must see it again, not start another
// import. The app calls preload() only to warm up, so there the error stays
// until the window reloads.
export function preloadable(factory) {
    let loaded = null;
    let pending = null;
    let awaited = false;
    let failure = null;
    const load = () => (pending ??= factory().then(module => {
        loaded = module.default ?? module;
        return loaded;
    }, error => {
        if (awaited) failure = error;
        pending = null;
        awaited = false;
        throw error;
    }));
    function Preloadable(props) {
        if (loaded) return createElement(loaded, props);
        if (failure) throw failure;
        const promise = load();
        awaited = true;
        throw promise;
    }
    Preloadable.preload = () => {
        failure = null;
        return load();
    };
    return Preloadable;
}
