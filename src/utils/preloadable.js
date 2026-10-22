import { createElement } from 'react';

// Like React.lazy, but renders synchronously once the module has loaded. A page
// warmed with preload() during idle time therefore never shows the Suspense
// fallback, and never pays React 19's 300 ms fallback-reveal throttle, which
// otherwise delays every cold route switch by exactly that much.
export function preloadable(factory) {
    let loaded = null;
    let pending = null;
    const load = () => (pending ??= factory().then(module => {
        loaded = module.default ?? module;
        return loaded;
    }));
    function Preloadable(props) {
        if (!loaded) throw load();
        return createElement(loaded, props);
    }
    Preloadable.preload = load;
    return Preloadable;
}
