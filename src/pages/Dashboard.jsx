import { useState, useEffect, useCallback } from 'react';
import { Search, SlidersHorizontal, RefreshCw } from 'lucide-react';

const Dashboard = ({ excludedSectors = [], autoRefreshInterval = 0 }) => {
    const [chartCount, setChartCount] = useState(20);
    const [searchTerm, setSearchTerm] = useState('');
    const [sector, setSector] = useState(''); // Empty string means "Any Sector"
    const [stocks, setStocks] = useState([]);
    const [loading, setLoading] = useState(true);

    const calculateRecoveryScore = async (symbol, electron, livePrice) => {
        if (!electron) {
            // Mock score if running outside Electron
            return Math.floor(Math.random() * 80) + 10;
        }

        try {
            const yahooData = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol);
            const result = yahooData?.chart?.result?.[0];
            if (!result) return 50;

            const timestamps = result.timestamp;
            const closes = result.indicators.quote[0].close;
            const chartData = timestamps.map((ts, index) => ({
                price: closes[index]
            })).filter(d => d.price !== null);

            if (chartData.length === 0) return 50;

            // Use the EXTREMELY accurate live price from Finviz overriding the delayed Yahoo daily close
            const currentPrice = livePrice || chartData[chartData.length - 1].price;
            
            // Ensure peak calculations respect the real-time live price if it happens to be higher
            const peakPrice = Math.max(livePrice || 0, ...chartData.map(d => d.price));
            const peakIndex = chartData.findIndex(d => d.price === peakPrice); // this might miss live peak, but handles historical drops
            const dipPercentage = peakPrice > 0 ? (((peakPrice - currentPrice) / peakPrice) * 100) : 0;

            let recoveryScore = 50;
            if (dipPercentage > 25) recoveryScore -= 20;
            else if (dipPercentage > 15) recoveryScore += 15;
            else if (dipPercentage > 5) recoveryScore += 25;
            else recoveryScore -= 10;

            let isBreakout = false;
            let isBreakdown = false;

            if (chartData.length - peakIndex > 5) {
                const recentSlice = chartData.slice(peakIndex);
                const recentLow = Math.min(...recentSlice.map(d => d.price));
                const recentHigh = Math.max(...recentSlice.map(d => d.price));
                
                if (currentPrice > recentLow * 1.02) recoveryScore += 20;
                else recoveryScore -= 15;

                // Support & Resistance checks for the alert system
                if (recentSlice.length >= 10) {
                    // if currently breaking below the recent low (support line)
                    if (currentPrice <= recentLow * 1.005 && dipPercentage > 5) {
                        isBreakdown = true;
                    }
                    // if currently breaking above the recent high (resistance line)
                    else if (currentPrice >= recentHigh * 0.995 && currentPrice > chartData[0].price) {
                        isBreakout = true;
                    }
                }
            }
            
            // Dispatch live alert asynchronously without blocking
            if (isBreakdown || isBreakout) {
                // Ensure we don't dispatch duplicate alerts via a global flag if possible
                if (!window._stockAlertsEmitted) window._stockAlertsEmitted = new Set();
                
                if (!window._stockAlertsEmitted.has(symbol)) {
                    window._stockAlertsEmitted.add(symbol);
                    
                    let alertColor = 'blue';
                    if (isBreakdown && dipPercentage >= 15) {
                        alertColor = 'amber';
                    }
                    
                    let message = isBreakout 
                        ? `Breaking resistance at $${currentPrice.toFixed(2)}` 
                        : `Breaking support at $${currentPrice.toFixed(2)}, accelerating downtrend`;
                    
                    if (alertColor === 'amber') {
                        message = `AMBER ALERT: Astonishingly huge drop of ${dipPercentage.toFixed(1)}%. Support shattered at $${currentPrice.toFixed(2)}!`;
                    }

                    const alertEvent = new CustomEvent('stock-alert', {
                        detail: {
                            symbol,
                            type: isBreakout ? 'breakout' : 'breakdown',
                            color: alertColor,
                            message: message,
                            timestamp: Date.now()
                        }
                    });
                    window.dispatchEvent(alertEvent);
                }
            }

            return Math.max(0, Math.min(100, recoveryScore));
        } catch (e) {
            console.error(`Failed to calc score for ${symbol}`, e);
            return 50;
        }
    };

    const fetchFinvizData = useCallback(async (targetCount) => {
        setLoading(true);
        try {
            let electron = null;
            if (typeof window !== 'undefined' && typeof window.require === 'function') {
                electron = window.require('electron');
            }

            let allStocks = [];

            if (!electron) {
                console.warn("Electron environment not detected. Loading mock dashboard data.");
                allStocks = [
                    { symbol: 'AAPL', name: 'Apple Inc.', price: 173.5, changePercentage: -2.4, dipPercentage: 2.4, recoveryProbability: 85, isZombie: false },
                    { symbol: 'TSLA', name: 'Tesla Inc.', price: 180.2, changePercentage: -5.1, dipPercentage: 5.1, recoveryProbability: 60, isZombie: false },
                    { symbol: 'DEAD', name: 'Zombie Corp', price: 0.5, changePercentage: -80.0, dipPercentage: 80.0, recoveryProbability: 10, isZombie: true },
                    { symbol: 'MSFT', name: 'Microsoft', price: 400.1, changePercentage: 1.2, dipPercentage: 0, recoveryProbability: 95, isZombie: false }
                ];
                setStocks(allStocks);
                setLoading(false);
                return;
            }

            let offset = 1;

            // --- PHOTONICS BASKET OVERRIDE ---
            if (sector === 'photonics') {
                const photonicsTickers = ['LITE', 'COHR', 'IPGP', 'MKSI', 'FN', 'CAMT', 'ONTO', 'VIAV'];
                // We construct a specific ticker search URL
                const tickerStr = photonicsTickers.join(',');
                const url = `https://finviz.com/screener.ashx?v=111&t=${tickerStr}`;
                const html = await electron.ipcRenderer.invoke('fetch-url', url);

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const rows = doc.querySelectorAll('tr');
                let pageStocks = [];

                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 10) {
                        const numberText = cells[0].textContent.trim();
                        const tickerLink = cells[1].querySelector('a[href^="quote.ashx"]');

                        if (parseInt(numberText) > 0 && tickerLink) {
                            const ticker = tickerLink.textContent.trim();
                            const changeStr = cells[9].textContent.trim();
                            const change = parseFloat(changeStr.replace('%', '')) || 0;

                            if (ticker && !pageStocks.find(s => s.symbol === ticker)) {
                                const cleanPrice = parseFloat(cells[8].textContent.trim().replace(/,/g, '')) || 0;
                                pageStocks.push({
                                    symbol: ticker,
                                    name: cells[2].textContent.trim(),
                                    price: cleanPrice,
                                    changePercentage: change,
                                    dipPercentage: change < 0 ? Math.abs(change) : 0,
                                    // Use explicit null so we know not to overwrite existing values prematurely during a merge
                                    recoveryProbability: null,
                                    isZombie: false
                                });
                            }
                        }
                    }
                });

                // Cleanly merge pageStocks into existing state to prevent flickering
                setStocks((prevStocks) => {
                    const newStocksList = pageStocks.map(newStock => {
                        const existing = prevStocks.find(p => p.symbol === newStock.symbol);
                        return existing ? { 
                            ...newStock, 
                            recoveryProbability: existing.recoveryProbability, 
                            isZombie: existing.isZombie 
                        } : { ...newStock, recoveryProbability: 50 };
                    });
                    return newStocksList;
                });

                // Fire async score calculations passing live prices
                Promise.all(pageStocks.map(async (stock) => {
                    const score = await calculateRecoveryScore(stock.symbol, electron, stock.price);
                    setStocks((prev) => prev.map(s => s.symbol === stock.symbol ? {
                        ...s,
                        recoveryProbability: score,
                        isZombie: score < 20
                    } : s));
                }));

                setLoading(false);
                return;
            }
            // --- END PHOTONICS OVERRIDE ---

            // Calculate how many pages we need (20 items per page)
            const pagesNeeded = Math.ceil(targetCount / 20);
            const pageIndices = Array.from({ length: pagesNeeded }, (_, i) => i * 20 + 1);

            let filterStr = 'ind_stocksonly%2Cta_perf_1wup%2Cta_perf2_4wup%2Cta_sma20_pa%2Cta_sma200_sb50%2Cta_sma50_sb20';
            if (sector) {
                filterStr += `%2Csec_${sector}`;
            }

            // Fire requests in parallel to drastically improve UI smoothness and fetch speed
            const pagePromises = pageIndices.map(async (offset) => {
                const url = `https://finviz.com/screener.ashx?v=111&p=d&f=${filterStr}&ta=0&dr=y1&o=-marketcap&r=${offset}`;
                const html = await electron.ipcRenderer.invoke('fetch-url', url);
                return { html, offset };
            });

            // Await all parallel fetches, but parse HTML out of loop
            const results = await Promise.all(pagePromises);
            
            // Reconstruct combined list
            let combinedStocksMap = new Map();

            for (const { html, offset } of results) {
                if (!html) continue;
                
                // Keep DOM Parsing fast by doing it sequentially after fetches complete
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const rows = doc.querySelectorAll('tr');

                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 10) {
                        const numberText = cells[0].textContent.trim();
                        const tickerLink = cells[1].querySelector('a[href^="quote.ashx"]');

                        if (parseInt(numberText) > 0 && tickerLink) {
                            const ticker = tickerLink.textContent.trim();

                            const finvizSectorStr = cells[3]?.textContent.trim().toLowerCase().replace(/ /g, '') || '';
                            if (excludedSectors.includes(finvizSectorStr)) {
                                return; // Skip
                            }

                            const changeStr = cells[9].textContent.trim();
                            const change = parseFloat(changeStr.replace('%', '')) || 0;

                            if (ticker && !combinedStocksMap.has(ticker)) {
                                const cleanPrice = parseFloat(cells[8].textContent.trim().replace(/,/g, '')) || 0;
                                combinedStocksMap.set(ticker, {
                                    symbol: ticker,
                                    name: cells[2].textContent.trim(),
                                    price: cleanPrice,
                                    changePercentage: change,
                                    dipPercentage: change < 0 ? Math.abs(change) : 0,
                                    recoveryProbability: null, // Keep null temporarily
                                    isZombie: false
                                });
                            }
                        }
                    }
                });
            }

            allStocks = Array.from(combinedStocksMap.values()).slice(0, targetCount);
            
            // Cleanly merge allStocks into existing state to prevent flickering
            setStocks((prevStocks) => {
                const newStocksList = allStocks.map(newStock => {
                    const existing = prevStocks.find(p => p.symbol === newStock.symbol);
                    return existing ? { 
                        ...newStock, 
                        recoveryProbability: existing.recoveryProbability, 
                        isZombie: existing.isZombie 
                    } : { ...newStock, recoveryProbability: 50 };
                });
                return newStocksList;
            });

            // Asynchronously hydrate scores for all fetched stocks simultaneously using live prices
            Promise.all(allStocks.map(async (stock) => {
                const score = await calculateRecoveryScore(stock.symbol, electron, stock.price);
                setStocks((prev) => prev.map(s => s.symbol === stock.symbol ? {
                    ...s,
                    recoveryProbability: score,
                    isZombie: score < 20
                } : s));
            })).catch(err => console.error("Error hydrating scores:", err));

        } catch (error) {
            console.error("Failed to fetch Finviz", error);
        } finally {
            setLoading(false);
        }
    }, [sector, excludedSectors]);

    useEffect(() => {
        fetchFinvizData(chartCount);
    }, [chartCount, fetchFinvizData]);

    useEffect(() => {
        if (autoRefreshInterval <= 0) return;

        const intervalId = setInterval(() => {
            fetchFinvizData(chartCount);
        }, autoRefreshInterval * 60 * 1000);

        return () => clearInterval(intervalId);
    }, [autoRefreshInterval, chartCount, fetchFinvizData]);

    const filteredStocks = stocks.filter(s => s.symbol.toLowerCase().includes(searchTerm.toLowerCase()));

    return (
        <div className="dashboard">
            {/* Header Area */}
            <div className="flex-between" style={{ marginBottom: '2rem' }}>
                <div>
                    <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        Market Dips Analysis
                        {loading && <RefreshCw size={20} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />}
                    </h2>
                    <p className="text-muted">Analyzing oversold opportunities based on your Finviz screener.</p>
                </div>
                
                <div style={{ marginRight: 'auto', paddingLeft: '2rem' }}>
                    <a href="https://www.stockfetcher.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline flex-center" style={{ gap: '0.5rem', textDecoration: 'none', borderColor: 'var(--primary)', color: 'var(--primary)', padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}>
                        <Search size={14} /> StockFetcher Reference
                    </a>
                </div>

                <div className="flex-center" style={{ gap: '1rem' }}>
                    <div className="glass-panel flex-center" style={{ padding: '0.5rem 1rem', gap: '0.5rem', borderRadius: '30px' }}>
                        <Search size={18} color="var(--text-muted)" />
                        <input
                            type="text"
                            placeholder="Search ticker..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                outline: 'none',
                                width: '150px',
                                fontFamily: 'inherit'
                            }}
                        />
                    </div>

                    <div className="glass-panel flex-center" style={{ padding: '0.5rem 1rem', gap: '0.5rem', borderRadius: '30px' }}>
                        <SlidersHorizontal size={18} color="var(--text-muted)" />

                        {/* Sector Filter Dropdown */}
                        <select
                            value={sector}
                            onChange={(e) => setSector(e.target.value)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                outline: 'none',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                borderRight: '1px solid rgba(255,255,255,0.1)',
                                paddingRight: '0.5rem',
                                marginRight: '0.5rem'
                            }}
                        >
                            <option value="">Any Sector</option>
                            <option value="basicmaterials">Basic Materials</option>
                            <option value="communicationservices">Communication Services</option>
                            <option value="consumercyclical">Consumer Cyclical</option>
                            <option value="consumerdefensive">Consumer Defensive</option>
                            <option value="energy">Energy</option>
                            <option value="financial">Financial</option>
                            <option value="healthcare">Healthcare</option>
                            <option value="industrials">Industrials</option>
                            <option value="realestate">Real Estate</option>
                            <option value="technology">Technology</option>
                            <option value="utilities">Utilities</option>
                        </select>

                        <select
                            value={chartCount}
                            onChange={(e) => setChartCount(Number(e.target.value))}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-main)',
                                outline: 'none',
                                cursor: 'pointer',
                                fontFamily: 'inherit'
                            }}
                        >
                            <option value={10}>Top 10 Dips</option>
                            <option value={20}>Top 20 Dips</option>
                            <option value={30}>Top 30 Dips</option>
                            <option value={50}>Top 50 Dips</option>
                            <option value={100}>Top 100 Dips</option>
                            <option value={250}>Top 250 Dips</option>
                            <option value={500}>Top 500 Dips</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Stocks Table */}
            <div className="glass-panel" style={{ padding: '1.5rem', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                            <th style={{ padding: '1rem 0.5rem', color: 'var(--text-muted)', fontWeight: '600' }}>Symbol</th>
                            <th style={{ padding: '1rem 0.5rem', color: 'var(--text-muted)', fontWeight: '600' }}>Company</th>
                            <th style={{ padding: '1rem 0.5rem', color: 'var(--text-muted)', fontWeight: '600', textAlign: 'right' }}>Price</th>
                            <th style={{ padding: '1rem 0.5rem', color: 'var(--text-muted)', fontWeight: '600', textAlign: 'right' }}>Dip %</th>
                            <th style={{ padding: '1rem 0.5rem', color: 'var(--text-muted)', fontWeight: '600', textAlign: 'center' }}>Rating</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredStocks.map((stock) => {
                            let scoreColor = 'var(--text-muted)';
                            let scoreText = 'Neutral';

                            if (stock.isZombie) {
                                scoreColor = '#9ca3af';
                                scoreText = 'ZOMBIE / DEAD';
                            } else if (stock.recoveryProbability >= 80) {
                                scoreColor = 'var(--success)';
                                scoreText = 'Strong Buy';
                            } else if (stock.recoveryProbability >= 60) {
                                scoreColor = '#22c55e';
                                scoreText = 'Buy';
                            } else if (stock.recoveryProbability >= 40) {
                                scoreColor = 'var(--warning)';
                                scoreText = 'Hold';
                            } else if (stock.recoveryProbability >= 20) {
                                scoreColor = '#f97316';
                                scoreText = 'Sell';
                            } else {
                                scoreColor = 'var(--danger)';
                                scoreText = 'Strong Sell';
                            }

                            return (
                                <tr 
                                    key={stock.symbol} 
                                    style={{ 
                                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                                        opacity: stock.isZombie ? 0.6 : 1,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s ease-in-out'
                                    }}
                                    onClick={() => window.location.hash = `/stock/${stock.symbol}`}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                                        e.currentTarget.style.transform = 'translateY(-1px)';
                                        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = 'transparent';
                                        e.currentTarget.style.transform = 'translateY(0)';
                                        e.currentTarget.style.boxShadow = 'none';
                                    }}
                                >
                                    <td style={{ padding: '1rem 0.5rem', fontWeight: 'bold', color: 'var(--text-main)' }}>{stock.symbol}</td>
                                    <td style={{ padding: '1rem 0.5rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{stock.name}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontWeight: '600', textAlign: 'right' }}>${stock.price.toFixed(2)}</td>
                                    <td style={{ padding: '1rem 0.5rem', color: 'var(--danger)', textAlign: 'right' }}>-{stock.dipPercentage}%</td>
                                    <td style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>
                                        <span style={{ 
                                            color: scoreColor, 
                                            border: `1px solid ${scoreColor}40`, 
                                            background: `${scoreColor}15`, 
                                            padding: '0.2rem 0.6rem', 
                                            borderRadius: '20px', 
                                            fontSize: '0.85rem',
                                            display: 'inline-block',
                                            minWidth: '100px'
                                        }}>
                                            {scoreText} ({stock.recoveryProbability})
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}

                        {loading && Array.from({ length: Math.max(0, chartCount - stocks.length) }).map((_, i) => (
                            <tr key={`loading-${i}`} style={{ opacity: 0.3 }}>
                                <td colSpan="5" style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                                    Scanning Finviz #{stocks.length + i + 1}...
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {!loading && filteredStocks.length === 0 && (
                    <div className="text-muted" style={{ padding: '2rem', textAlign: 'center' }}>No stocks found matching your criteria.</div>
                )}
            </div>
            {/* Adding this style locally for the spinner */}
            <style>{`
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default Dashboard;
