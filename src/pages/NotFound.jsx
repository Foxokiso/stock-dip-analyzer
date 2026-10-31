import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';

// The catch-all route. An unknown or malformed hash, such as #/stock/ with no
// symbol, gets a desk that says so instead of an empty <main>.
export default function NotFound() {
    const { pathname } = useLocation();
    return (
        <div className="desk-empty glass-panel not-found">
            <h1>Page not found</h1>
            <p>Nothing in the workspace lives at <code>{pathname}</code>.</p>
            <Link to="/"><LayoutDashboard size={14} aria-hidden="true" />Go to Overview</Link>
        </div>
    );
}
