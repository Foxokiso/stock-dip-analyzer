import React, { useState, useEffect, useRef } from 'react';
import { Compass, BarChart2, Activity, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

const Discovery = ({ excludedSectors }) => {
    const [loading, setLoading] = useState(true);
    const [discoveredStocks, setDiscoveredStocks] = useState([]);
    const [activeWidgetSymbol, setActiveWidgetSymbol] = useState('SPY');
    const chartContainerRef = useRef(null);

    useEffect(() => {
        if (!activeWidgetSymbol || !chartContainerRef.current) return;

        chartContainerRef.current.innerHTML = '';
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        script.onload = () => {
            if (window.TradingView) {
                new window.TradingView.widget({
                    autosize: true,
                    symbol: activeWidgetSymbol,
                    interval: "D",
                    timezone: "Etc/UTC",
                    theme: "dark",
                    style: "1",
                    locale: "en",
                    enable_publishing: false,
                    container_id: "tv_discovery_chart"
                });
            }
        };
        chartContainerRef.current.appendChild(script);
    }, [activeWidgetSymbol]);

    useEffect(() => {
        const fetchDiscoveryList = async () => {
            setLoading(true);
            try {
                if (typeof window.require === 'function') {
                    const electron = window.require('electron');
                    // Fetch stocks with Unusual Volume & High Volatility to find active new tickers
                    const url = `https://finviz.com/screener.ashx?v=111&f=ta_unusualvolume,ta_volatility_mo5&o=-volume`;
                    const html = await electron.ipcRenderer.invoke('fetch-url', url);
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    const rows = doc.querySelectorAll('tr');
                    let results = [];

                    rows.forEach(row => {
                        if (results.length >= 20) return;
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 10) {
                            const tickerLink = cells[1].querySelector('a[href^="quote.ashx"]');
                            if (tickerLink) {
                                const ticker = tickerLink.textContent.trim();
                                const sectorStr = cells[3]?.textContent.trim().toLowerCase().replace(/ /g, '') || '';

                                // Respect the App-wide Global exclusions!
                                if (excludedSectors.includes(sectorStr)) {
                                    return;
                                }

                                if (!results.find(s => s.symbol === ticker)) {
                                    results.push({
                                        symbol: ticker,
                                        name: cells[2].textContent.trim(),
                                        sector: cells[3].textContent.trim(),
                                        price: parseFloat(cells[8].textContent.trim()) || 0,
                                        change: parseFloat(cells[9].textContent.replace('%', '')) || 0,
                                        volume: cells[10] ? cells[10].textContent.trim() : ''
                                    });
                                }
                            }
                        }
                    });

                    setDiscoveredStocks(results);
                    if (results.length > 0) {
                        setActiveWidgetSymbol(results[0].symbol);
                    }
                } else {
                    console.warn("Electron environment not detected. Loading mock discovery data.");
                    setDiscoveredStocks([
                        { symbol: 'PLTR', name: 'Palantir Technologies', sector: 'Technology', price: 24.50, change: 8.5, volume: '85M' },
                        { symbol: 'SMCI', name: 'Super Micro Computer', sector: 'Technology', price: 850.20, change: 12.4, volume: '12M' },
                        { symbol: 'COIN', name: 'Coinbase Global', sector: 'Financial', price: 210.30, change: 5.2, volume: '15M' }
                    ]);
                    setActiveWidgetSymbol('PLTR');
                }
            } catch (err) {
                console.error("Error fetching Discovery list:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchDiscoveryList();
    }, [excludedSectors]);

    return (
        <div className="discovery-page">
            <div className="flex-between" style={{ marginBottom: '2rem' }}>
                <div>
                    <h2 className="text-gradient flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem' }}>
                        <Compass size={24} color="var(--primary)" />
                        Alternative Resource Discovery
                    </h2>
                    <p className="text-muted">Uncommon metrics, unusual volume, and advanced TradingView charting.</p>
                </div>
                
                <div>
                    <a href="https://www.stockfetcher.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline flex-center" style={{ gap: '0.5rem', textDecoration: 'none', borderColor: 'var(--primary)', color: 'var(--primary)', padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
                        <Compass size={14} /> StockFetcher Reference
                    </a>
                </div>
            </div>

            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                {/* TradingView Advanced Chart Integration */}
                <div className="glass-panel" style={{ flex: '2 1 600px', padding: '1.5rem', minHeight: '500px', display: 'flex', flexDirection: 'column' }}>
                    <h3 className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', marginBottom: '1rem', color: 'var(--text-main)' }}>
                        <BarChart2 size={20} color="var(--secondary)" />
                        TradingView Advanced Chart
                    </h3>
                    <div id="tv_discovery_chart" ref={chartContainerRef} style={{ flex: 1, borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                        {/* TradingView script will inject here, replacing the deprecated widgetembed iframe */}
                    </div>
                </div>

                {/* Discovery Scan Results */}
                <div className="glass-panel" style={{ flex: '1 1 350px', padding: '1.5rem', maxHeight: '600px', overflowY: 'auto' }}>
                    <h3 className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', marginBottom: '1.5rem', color: 'var(--warning)' }}>
                        <Zap size={20} />
                        Unusual Volume Scanner
                    </h3>
                    <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
                        Currently tracking hyper-active tickers outside of your omitted sectors. Click any row to load it into TradingView.
                    </p>

                    {loading ? (
                        <div className="text-center text-muted" style={{ padding: '2rem 0' }}>Scanning the market...</div>
                    ) : discoveredStocks.length === 0 ? (
                        <div className="text-center text-muted">No active tickers found matching criteria.</div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {discoveredStocks.map((stock, idx) => (
                                <div
                                    key={`${stock.symbol}-${idx}`}
                                    onClick={() => setActiveWidgetSymbol(stock.symbol)}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        padding: '0.75rem 1rem',
                                        background: activeWidgetSymbol === stock.symbol ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.2)',
                                        borderRadius: '8px',
                                        cursor: 'pointer',
                                        transition: 'background 0.2s'
                                    }}
                                    onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
                                    onMouseOut={(e) => {
                                        if (activeWidgetSymbol !== stock.symbol) {
                                            e.currentTarget.style.background = 'rgba(0,0,0,0.2)';
                                        } else {
                                            e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                                        }
                                    }}
                                >
                                    <div>
                                        <div style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            {stock.symbol}
                                            <Link to={`/stock/${stock.symbol}`} title="View Dip Analysis" onClick={(e) => e.stopPropagation()}>
                                                <Activity size={14} color="var(--primary)" />
                                            </Link>
                                        </div>
                                        <div className="text-muted" style={{ fontSize: '0.75rem' }}>{stock.sector}</div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontWeight: '500' }}>Vol: {stock.volume}</div>
                                        <div style={{ fontSize: '0.8rem', color: stock.change >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                                            {stock.change > 0 ? '+' : ''}{stock.change.toFixed(2)}%
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Discovery;
