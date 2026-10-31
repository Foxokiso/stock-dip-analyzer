import { Component } from 'react';
import { AlertTriangle, LayoutDashboard, RotateCw } from 'lucide-react';

// Contains a render error to the part of the window that failed. Without a
// boundary React unmounts the whole root, header and navigation included, and
// leaves an empty window. `fallback` renders in its place with { error, reset };
// a change of `resetKey` clears the error (the routed desk passes the pathname,
// so leaving a failed desk renders the next one normally).
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Render error caught by an error boundary:', error, info.componentStack);
  }

  componentDidUpdate(previous, previousState) {
    // Only an error caught before the key changed is cleared. One caught while
    // rendering the new key belongs to it; clearing that would render the
    // failing desk a second time and catch (and log) the same failure twice.
    if (previousState.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const Fallback = this.props.fallback;
    return <Fallback error={error} reset={this.reset} />;
  }
}

// The standard fallback. Chromium keeps a failed chunk import failed until the
// window reloads, so Reload is the dependable way back; Go to Overview leaves
// the failed desk without reloading. Where that is a route change, the route
// change resets the boundary (`resetsOnNavigation`). Resetting here as well
// would first render the failed desk again at its old location, and React
// would report that error as an uncaught "recovered" one.
export function ErrorPanel({ title, error, reset, resetsOnNavigation = false }) {
  const goToOverview = () => {
    window.location.hash = '#/';
    if (!resetsOnNavigation) reset();
  };
  return (
    <section className="desk-error glass-panel" role="alert">
      <AlertTriangle size={22} aria-hidden="true" />
      <h1>{title}</h1>
      <p>Reload the window to try again, or go back to the Overview.</p>
      <p className="desk-error-detail">{error?.message || String(error)}</p>
      <div className="desk-error-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}><RotateCw size={15} aria-hidden="true" />Reload</button>
        <button type="button" className="btn btn-outline" onClick={goToOverview}><LayoutDashboard size={15} aria-hidden="true" />Go to Overview</button>
      </div>
    </section>
  );
}
