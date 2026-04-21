import React, { useState, useEffect } from 'react';
import { Trophy, TrendingUp, DollarSign, Percent, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';

const ETFAwards = ({ excludedSectors, autoRefreshInterval = 0, globalFilter = 'All' }) => {
    const [loading, setLoading] = useState(true);
    const [etfs, setEtfs] = useState({
        performance: [],
        dividend: [],
        capitalGain: []
    });

    useEffect(() => {
        const fetchEtfs = async () => {
            setLoading(true);
            try {
                if (typeof window.require === 'function') {
                    const electron = window.require('electron');

                    const fetchCategory = async (sortOrder) => {
                        const url = `https://finviz.com/screener.ashx?v=111&f=ind_exchangetradedfund&o=${sortOrder}`;
                        const html = await electron.ipcRenderer.invoke('fetch-url', url);
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        const rows = doc.querySelectorAll('tr');
                        let results = [];

                        rows.forEach(row => {
                            if (results.length >= 10) return;
                            const cells = row.querySelectorAll('td');
                            if (cells.length >= 10) {
                                const numberText = cells[0].textContent.trim();
                                const tickerLink = cells[1].querySelector('a[href^="quote.ashx"]');
                                if (parseInt(numberText) > 0 && tickerLink) {
                                    const ticker = tickerLink.textContent.trim();
                                    const price = parseFloat(cells[8].textContent.trim()) || 0;
                                    const change = parseFloat(cells[9].textContent.replace('%', '')) || 0;
                                    const volume = cells[10] ? cells[10].textContent.trim() : '';

                                    results.push({
                                        symbol: ticker,
                                        name: cells[2].textContent.trim(),
                                        price,
                                        change,
                                        volume
                                    });
                                }
                            }
                        });
                        return results;
                    };

                    const perf = await fetchCategory('-perf4w');
                    await new Promise(resolve => setTimeout(resolve, 800)); // Rate limit 

                    const div = await fetchCategory('-dividendyield');
                    await new Promise(resolve => setTimeout(resolve, 800));

                    const cap = await fetchCategory('-perf52w');

                    setEtfs({
                        performance: perf,
                        dividend: div,
                        capitalGain: cap
                    });
                } else {
                    console.warn("Electron environment not detected. Loading mock data.");
                    setEtfs({
                        performance: [
                            { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull', price: 42.50, change: 5.2 },
                            { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', price: 61.20, change: 3.1 }
                        ],
                        dividend: [
                            { symbol: 'SCHD', name: 'Schwab US Dividend Equity', price: 78.40, change: 0.2 },
                            { symbol: 'VYM', name: 'Vanguard High Dividend Yield', price: 115.60, change: 0.1 }
                        ],
                        capitalGain: [
                            { symbol: 'SPY', name: 'SPDR S&P 500', price: 512.30, change: 0.8 },
                            { symbol: 'QQQ', name: 'Invesco QQQ Trust', price: 445.10, change: 1.1 }
                        ]
                    });
                }
            } catch (err) {
                console.error("Error fetching ETFs:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchEtfs();

        if (autoRefreshInterval > 0) {
            const intervalId = setInterval(() => {
                fetchEtfs();
            }, autoRefreshInterval * 60 * 1000);
            return () => clearInterval(intervalId);
        }
    }, [excludedSectors, autoRefreshInterval]);

    const renderEtfList = (title, icon, data, highlightColor) => {
        const filteredData = data.filter(etf => {
            if (globalFilter === 'All') return true;
            if (globalFilter === 'Bullish' || globalFilter === 'Strong Buy' || globalFilter === 'Buy') return etf.change > 0;
            if (globalFilter === 'Bearish' || globalFilter === 'Sell/Strong Sell' || globalFilter === 'Hold' || globalFilter === 'Sell') return etf.change < 0;
            return true;
        });
        
        return (
        <div className="glass-panel" style={{ padding: '1.5rem', flex: 1 }}>
            <h3 className="flex-center" style={{ gap: '0.5rem', marginBottom: '1.5rem', color: highlightColor }}>
                {icon}
                {title}
            </h3>
            {filteredData.map((etf, i) => (
                <div key={etf.symbol} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '0.75rem 0',
                    borderBottom: i < data.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none'
                }}>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 'bold', width: '20px' }}>#{i + 1}</span>
                        <Link to={`/stock/${etf.symbol}`} style={{ fontWeight: 'bold', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            {etf.symbol}
                        </Link>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: '500' }}>${etf.price.toFixed(2)}</div>
                        <div style={{
                            fontSize: '0.8rem',
                            color: etf.change >= 0 ? 'var(--success)' : 'var(--danger)'
                        }}>
                            {etf.change > 0 ? '+' : ''}{etf.change.toFixed(2)}%
                        </div>
                    </div>
                </div>
            ))}
        </div>
        );
    };

    return (
        <div className="etf-awards-page">
            <div className="flex-between" style={{ marginBottom: '2rem' }}>
                <div>
                    <h2 className="text-gradient flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem' }}>
                        <Trophy size={24} color="var(--primary)" />
                        Daily Top 10 ETF Awards
                    </h2>
                    <p className="text-muted">Ranking the strongest Exchange Traded Funds across key performance metrics.</p>
                </div>
                <div>
                    <a href="https://etfdb.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline flex-center" style={{ gap: '0.5rem', textDecoration: 'none' }}>
                        <ExternalLink size={16} /> ETF Database Reference
                    </a>
                </div>
            </div>

            {loading ? (
                <div className="flex-center" style={{ height: '300px' }}>
                    <div className="text-muted" style={{ fontSize: '1.2rem', animation: 'pulse-success 2s infinite', padding: '1rem', borderRadius: '50%' }}>
                        Analyzing ETF Metrics...
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                    {renderEtfList('Top Mover (4W)', <TrendingUp size={20} />, etfs.performance, 'var(--primary)')}
                    {renderEtfList('Highest Yield', <DollarSign size={20} />, etfs.dividend, 'var(--success)')}
                    {renderEtfList('Capital Gain (1Y)', <Percent size={20} />, etfs.capitalGain, 'var(--warning)')}
                </div>
            )}
        </div>
    );
};

export default ETFAwards;
