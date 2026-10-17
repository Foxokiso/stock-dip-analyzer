import { useState, useEffect, useRef } from 'react';
import { Compass, BarChart2, Activity, Zap, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { parseFinvizScreener } from '../utils/finviz';
import { formatPrice, formatPct, formatCompact, formatQuoteTime } from '../utils/format';
import { mountTradingViewWidget } from '../utils/tradingView';
import { useSettings } from '../state/settingsContext.js';
import '../styles/pages/etf-discovery.css';

const normalizeSector = (sector) => sector.toLowerCase().replace(/[^a-z]/g, '');

// TradingView paints its chart on a canvas inside its own iframe, so the brief's
// chart roles cannot reach it through CSS. They are read from the live cascade
// at mount time (never typed by hand) and handed over as plain colour strings.
const CHART_ROLES = {
    background: '--bg-card', grid: '--line', text: '--text-muted',
    series: '--secondary', up: '--success', down: '--danger',
};

const cssColor = ([r, g, b, a]) => a === 255
    ? `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;

// Resolves each role token to an sRGB string through a 1x1 canvas. Returns null
// when anything cannot be resolved so the widget simply keeps its own defaults.
function resolveChartPalette(container) {
    const doc = container?.ownerDocument;
    const view = doc?.defaultView;
    if (!view?.getComputedStyle || typeof doc.createElement !== 'function') return null;
    const canvas = doc.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext?.('2d', { willReadFrequently: true });
    if (!context) return null;
    const probe = doc.createElement('span');
    probe.className = 'discovery-token-probe';
    container.appendChild(probe);
    try {
        const palette = {};
        for (const [role, token] of Object.entries(CHART_ROLES)) {
            probe.style.color = `var(${token})`;
            const color = view.getComputedStyle(probe).color;
            context.fillStyle = 'transparent';
            const unset = context.fillStyle;
            context.fillStyle = color;
            if (!color || context.fillStyle === unset) return null;
            context.clearRect(0, 0, 1, 1);
            context.fillRect(0, 0, 1, 1);
            const pixel = context.getImageData(0, 0, 1, 1).data;
            if (pixel[3] === 0) return null;
            palette[role] = cssColor(pixel);
        }
        return palette;
    } catch {
        return null;
    } finally {
        probe.remove();
    }
}

// Candles keep the up/down semantics; the line and area styles take the
// --secondary stroke; grid, scales and ground follow --line / --text-muted / --bg-card.
const chartPaletteOptions = (palette) => palette ? {
    backgroundColor: palette.background,
    gridColor: palette.grid,
    overrides: {
        'paneProperties.background': palette.background,
        'paneProperties.backgroundType': 'solid',
        'paneProperties.vertGridProperties.color': palette.grid,
        'paneProperties.horzGridProperties.color': palette.grid,
        'scalesProperties.textColor': palette.text,
        'scalesProperties.lineColor': palette.grid,
        'mainSeriesProperties.candleStyle.upColor': palette.up,
        'mainSeriesProperties.candleStyle.downColor': palette.down,
        'mainSeriesProperties.candleStyle.borderUpColor': palette.up,
        'mainSeriesProperties.candleStyle.borderDownColor': palette.down,
        'mainSeriesProperties.candleStyle.wickUpColor': palette.up,
        'mainSeriesProperties.candleStyle.wickDownColor': palette.down,
        'mainSeriesProperties.lineStyle.color': palette.series,
        'mainSeriesProperties.areaStyle.linecolor': palette.series,
    },
} : {};

const Discovery = ({ excludedSectors = [], autoRefreshInterval = 0, globalFilter = 'All' }) => {
    const { settings } = useSettings();
    const theme = settings.appearance.theme;
    const [loading, setLoading] = useState(true);
    const [discoveredStocks, setDiscoveredStocks] = useState([]);
    const [fetchedAt, setFetchedAt] = useState(null);
    const [error, setError] = useState('');
    const [stale, setStale] = useState(false);
    const [activeWidgetSymbol, setActiveWidgetSymbol] = useState('SPY');
    const [chartError, setChartError] = useState(null);
    const [chartRetry, setChartRetry] = useState(0);
    const chartContainerRef = useRef(null);

    useEffect(() => {
        const container = chartContainerRef.current;
        if (!activeWidgetSymbol || !container) return;
        let unmount = null;
        // App.jsx writes `theme` to <body> in its own, later effect: mounting on the
        // next task lets the palette be read from a cascade that already reflects it.
        const timer = setTimeout(() => {
            unmount = mountTradingViewWidget(container, {
                autosize: true, symbol: activeWidgetSymbol, interval: 'D', timezone: 'Etc/UTC',
                theme: 'dark', style: '1', locale: 'en', enable_publishing: false,
                container_id: 'tv_discovery_chart',
                ...chartPaletteOptions(resolveChartPalette(container)),
            }, {
                onReady: () => setChartError(null),
                onError: error => setChartError({ symbol: activeWidgetSymbol, message: error.message }),
            });
        }, 0);
        return () => { clearTimeout(timer); unmount?.(); };
    }, [activeWidgetSymbol, chartRetry, theme]);

    useEffect(() => {
        let cancelled = false, inFlight = false;
        const fetchDiscoveryList = async () => {
            if (inFlight) return;
            inFlight = true;
            await Promise.resolve();
            if (cancelled) return;
            setLoading(true);
            if (typeof window.require !== 'function') {
                setError('Discovery quotes require the desktop app connection.');
                setLoading(false);
                inFlight = false;
                return;
            }
            try {
                const html = await window.require('electron').ipcRenderer.invoke('fetch-url', 'https://finviz.com/screener.ashx?v=111&f=ta_unusualvolume,ta_volatility_mo5&o=-volume');
                const fetched = new Date().toISOString();
                const results = parseFinvizScreener(html, { fetchedAt: fetched }).slice(0, 20);
                if (!cancelled) {
                    setDiscoveredStocks(results);
                    setFetchedAt(fetched);
                    setStale(false);
                    setError('');
                }
            } catch (err) {
                if (!cancelled) { setError(err.message || 'Finviz Discovery data is unavailable.'); setStale(true); }
            } finally {
                inFlight = false;
                if (!cancelled) setLoading(false);
            }
        };
        fetchDiscoveryList();
        const timer = autoRefreshInterval > 0 ? setInterval(fetchDiscoveryList, autoRefreshInterval * 60 * 1000) : null;
        return () => { cancelled = true; if (timer) clearInterval(timer); };
    }, [autoRefreshInterval]);

    const hasRatingFilter = !['All', 'Bullish', 'Bearish'].includes(globalFilter);
    const stocks = discoveredStocks.filter(stock => !excludedSectors.includes(normalizeSector(stock.sector)) && !hasRatingFilter && (globalFilter === 'All' || (globalFilter === 'Bullish' ? stock.change > 0 : stock.change < 0)));
    return (
        <div className="discovery-page">
            <div className="page-heading flex-between">
                <div><p className="eyebrow">Market exploration</p><h2><Compass size={24} /> Discovery</h2><p className="text-muted">Unusual volume and monthly volatility, with TradingView chart research.</p></div>
                <a href="https://www.stockfetcher.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline"><Compass size={14} /> StockFetcher</a>
            </div>
            <div className="source-banner"><span>Finviz · US equities delayed 1 minute · Quote timestamp not supplied</span><span className="discovery-banner-time">{fetchedAt ? `Fetched ${formatQuoteTime(fetchedAt)}${stale ? ' · Stale' : ''}` : 'No verified quotes loaded'}</span></div>
            {error && <p className="data-notice" role="status">{error}{stale && discoveredStocks.length > 0 ? ' Showing the last successful scan.' : ''}</p>}
            {hasRatingFilter && <p className="data-notice">Discovery results do not carry recovery ratings. Select All Ratings, Bullish, or Bearish to view the scan.</p>}
            <div className="discovery-grid">
                <section className="glass-panel discovery-chart-panel">
                    <h3><BarChart2 size={18} /> TradingView · {activeWidgetSymbol}</h3>
                    <p className="source-meta">Chart data and quote delay are supplied by TradingView.</p>
                    {chartError?.symbol === activeWidgetSymbol && <div className="data-notice" role="status"><span>{chartError.message}</span><button type="button" className="btn btn-outline" onClick={() => setChartRetry(previous => previous + 1)}>Retry chart</button></div>}
                    <div id="tv_discovery_chart" ref={chartContainerRef} className="discovery-chart" />
                </section>
                <section className={`glass-panel discovery-results-panel${stale ? ' data-stale' : ''}`}>
                    <h3><Zap size={18} /> Unusual volume {loading && <RefreshCw size={13} className="spin" />}</h3>
                    <p className="text-muted">Select a ticker to inspect its chart.</p>
                    {stocks.length === 0 && <div className="desk-empty">{loading ? 'Scanning the market…' : error && !fetchedAt ? 'Scanner unavailable.' : 'No tickers match the current filters.'}</div>}
                    {stocks.map(stock => {
                        const isSelected = activeWidgetSymbol === stock.symbol;
                        return (
                            <div key={stock.symbol} className={`discovery-stock-row${isSelected ? ' is-selected' : ''}`}>
                                <button type="button" onClick={() => setActiveWidgetSymbol(stock.symbol)} className="discovery-ticker-button" aria-pressed={isSelected}><strong>{stock.symbol}</strong><span className="quote-meta">{stock.sector}</span></button>
                                <div className="discovery-stock-values"><span>{formatPrice(stock.price)}</span><span className={stock.change == null ? 'text-muted' : stock.change >= 0 ? 'text-success' : 'text-danger'}>{formatPct(stock.change)}</span><span className="quote-meta">Vol {formatCompact(stock.volume)}</span></div>
                                <Link to={`/stock/${stock.symbol}`} className="discovery-analysis-link" title={`View ${stock.symbol} analysis`} aria-label={`View ${stock.symbol} analysis`}><Activity size={16} /></Link>
                            </div>
                        );
                    })}
                </section>
            </div>
        </div>
    );
};
export default Discovery;
