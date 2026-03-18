import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, TrendingDown, AlertTriangle, ArrowUpRight, RefreshCw } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const StockDetails = () => {
    const { symbol } = useParams();
    const [chartData, setChartData] = useState([]);
    const [news, setNews] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                let electron = null;
                if (typeof window !== 'undefined' && typeof window.require === 'function') {
                    electron = window.require('electron');
                }

                if (!electron) {
                     // Fallback mock data if running in a standard browser
                     setTimeout(() => {
                         setChartData([
                             { date: '10/1', price: 150 },
                             { date: '10/2', price: 155 },
                             { date: '10/3', price: 145 },
                             { date: '10/4', price: 130 },
                             { date: '10/5', price: 135 }
                         ]);
                         setNews([
                             { time: '10/5 09:00AM', title: 'Mock News: Market Reacts to Fake Earnings', link: 'https://finviz.com' },
                             { time: '10/4 01:20PM', title: 'Mock News: Dow drops 500 points', link: 'https://finviz.com' }
                         ]);
                         setLoading(false);
                     }, 1000);
                     return;
                }

                // 1. Fetch Yahoo Finance Chart
                const yahooData = await electron.ipcRenderer.invoke('fetch-yahoo-chart', symbol);
                const result = yahooData?.chart?.result?.[0];
                if (result) {
                    const timestamps = result.timestamp;
                    const closes = result.indicators.quote[0].close;
                    const formattedChartData = timestamps.map((ts, index) => {
                        const date = new Date(ts * 1000);
                        return {
                            date: `${date.getMonth() + 1}/${date.getDate()}`,
                            price: closes[index]
                        };
                    }).filter(d => d.price !== null);
                    setChartData(formattedChartData);
                }

                // 2. Fetch Finviz News
                const finvizUrl = `https://finviz.com/quote.ashx?t=${symbol}&p=d`;
                const finvizHtml = await electron.ipcRenderer.invoke('fetch-url', finvizUrl);
                const parser = new DOMParser();
                const doc = parser.parseFromString(finvizHtml, 'text/html');

                const newsRows = doc.querySelectorAll('#news-table tr');
                const extractedNews = [];
                let lastDate = "";

                for (let i = 0; i < newsRows.length && extractedNews.length < 5; i++) {
                    const row = newsRows[i];
                    const cells = row.querySelectorAll('td');
                    if (cells.length === 2) {
                        const timeRaw = cells[0].textContent.trim();
                        // Finviz formats times like "Oct-14-23 09:00AM" or just "09:00AM" if it's the same day
                        if (timeRaw.includes(' ')) {
                            lastDate = timeRaw.split(' ')[0];
                        }

                        const time = timeRaw.includes(' ') ? timeRaw : `${lastDate} ${timeRaw}`;

                        const linkEl = cells[1].querySelector('a');
                        if (linkEl) {
                            extractedNews.push({
                                time,
                                title: linkEl.textContent.trim(),
                                link: linkEl.href
                            });
                        }
                    }
                }
                setNews(extractedNews);

            } catch (err) {
                console.error("Error loading stock details:", err);
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [symbol]);

    const currentPrice = chartData.length > 0 ? chartData[chartData.length - 1].price : 0;
    const peakPrice = chartData.length > 0 ? Math.max(...chartData.map(d => d.price)) : 0;
    const peakIndex = chartData.length > 0 ? chartData.findIndex(d => d.price === peakPrice) : 0;
    const dipPercentage = peakPrice > 0 ? (((peakPrice - currentPrice) / peakPrice) * 100).toFixed(2) : 0;

    const peakDate = chartData.length > 0 ? chartData[peakIndex].date : "N/A";

    // Calculate where the price "normalized" before the crash (average of up to 5 days leading up to the peak)
    let normalizedHigh = peakPrice;
    if (peakIndex >= 1) {
        const daysToAverage = Math.min(peakIndex, 5);
        const prePeakPrices = chartData.slice(peakIndex - daysToAverage, peakIndex).map(d => d.price);
        normalizedHigh = prePeakPrices.reduce((a, b) => a + b, 0) / prePeakPrices.length;
    }

    // AI Heuristics to rate recovery chance
    let recoveryScore = 50;
    if (chartData.length > 0) {
        // Factor 1: Depth of the dip. Between 5% and 25% is an attractive buy zone.
        if (dipPercentage > 25) recoveryScore -= 20; // Falling knife
        else if (dipPercentage > 15) recoveryScore += 15; // Solid correction
        else if (dipPercentage > 5) recoveryScore += 25; // Good dip
        else recoveryScore -= 10; // Not much of a dip yet

        // Factor 2: Is it already recovering since the peak?
        if (chartData.length - peakIndex > 5) {
            const recentLow = Math.min(...chartData.slice(peakIndex).map(d => d.price));
            if (currentPrice > recentLow * 1.02) {
                recoveryScore += 20; // Shows signs of life
            } else {
                recoveryScore -= 15; // Still bleeding
            }
        }
    }

    // Clamp between 0 and 100
    recoveryScore = Math.max(0, Math.min(100, recoveryScore));

    const getScoreColor = (score) => {
        if (score >= 70) return 'var(--success)';
        if (score >= 40) return 'var(--warning)';
        return 'var(--danger)';
    };

    const getScoreBackground = (score) => {
        if (score < 20) return 'rgba(100, 100, 100, 0.1)';
        if (score >= 70) return 'rgba(0, 230, 118, 0.1)';
        if (score >= 40) return 'rgba(255, 234, 0, 0.1)';
        return 'rgba(255, 82, 82, 0.1)';
    };

    const isZombie = recoveryScore < 20;
    const scoreColor = isZombie ? '#9ca3af' : getScoreColor(recoveryScore); // improved contrast
    const scoreBg = getScoreBackground(recoveryScore);

    let scoreClass = '';
    if (isZombie) scoreClass = '';
    else if (recoveryScore >= 70) scoreClass = 'rating-pulse-success';
    else if (recoveryScore >= 40) scoreClass = 'rating-pulse-warning';
    else scoreClass = 'rating-pulse-danger';

    return (
        <div className="stock-details">
            <Link to="/" className="btn btn-outline" style={{ marginBottom: '2rem' }}>
                <ArrowLeft size={16} /> Back to Dashboard
            </Link>

            {loading ? (
                <div className="flex-center" style={{ height: '50vh', flexDirection: 'column', gap: '1rem' }}>
                    <RefreshCw size={40} className="text-muted" style={{ animation: 'spin 1s linear infinite' }} />
                    <p className="text-muted">Analyzing {symbol}...</p>
                </div>
            ) : (
                <>
                    <div className="flex-between" style={{ alignItems: 'flex-start', marginBottom: '2rem' }}>
                        <div>
                            <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                {symbol}
                                <span className={isZombie ? "glass-panel flex-center" : "glass-panel text-danger flex-center"}
                                    style={{ color: isZombie ? '#9ca3af' : 'var(--danger)', fontSize: '1rem', padding: '4px 12px', borderRadius: '20px', gap: '4px' }}>
                                    <TrendingDown size={14} /> {isZombie ? 'DEAD' : `${dipPercentage}% Dip`}
                                </span>
                            </h1>
                            <p className="text-muted" style={{ fontSize: '1.1rem', marginTop: '0.5rem' }}>
                                Current Price: <strong style={{ color: 'var(--text-main)' }}>${currentPrice.toFixed(2)}</strong>
                                <span style={{ margin: '0 10px' }}>|</span>
                                Peak: <strong style={{ color: 'var(--text-main)' }}>${peakPrice.toFixed(2)}</strong> on {peakDate}
                                <span style={{ margin: '0 10px' }}>|</span>
                                Baseline Norm: <strong style={{ color: 'var(--text-main)' }}>${normalizedHigh.toFixed(2)}</strong>
                            </p>
                        </div>
                        <button className="btn btn-primary">
                            Add to Watchlist
                        </button>
                    </div>

                    <div className="glass-panel" style={{ padding: '2rem', height: '400px', marginBottom: '2rem' }}>
                        <h3 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Price Action (30 Days)</h3>
                        <ResponsiveContainer width="100%" height={320}>
                            <AreaChart data={chartData}>
                                <defs>
                                    <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="var(--danger)" stopOpacity={0.8} />
                                        <stop offset="95%" stopColor="var(--danger)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                                <XAxis dataKey="date" stroke="var(--text-muted)" tick={{ fill: 'var(--text-muted)' }} />
                                <YAxis stroke="var(--text-muted)" domain={['dataMin - 5', 'dataMax + 5']} tick={{ fill: 'var(--text-muted)' }} />
                                <Tooltip
                                    contentStyle={{ backgroundColor: 'var(--bg-dark)', border: 'var(--glass-border)', borderRadius: '8px' }}
                                    itemStyle={{ color: 'var(--text-main)' }}
                                />
                                <Area type="monotone" dataKey="price" stroke="var(--danger)" fillOpacity={1} fill="url(#colorPrice)" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
                        <div className="glass-panel" style={{ padding: '2rem' }}>
                            <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={20} color="var(--warning)" />
                                AI Analysis
                            </h3>
                            <p className="text-muted" style={{ lineHeight: '1.7' }}>
                                {isZombie ? (
                                    <>Based on the 30-day historical chart, {symbol} has flatlined into a <strong>ZOMBIE STOCK</strong>. It reached a high of ${peakPrice.toFixed(2)} on {peakDate} but has since crashed {dipPercentage}% with minimal-to-zero signs of recovery volatility. Our AI analysis highly suggests avoiding due to lack of buyer momentum.</>
                                ) : (
                                    <>Based on the 30-day historical chart, {symbol} reached a high of ${peakPrice.toFixed(2)} on {peakDate}, after normalizing around ${normalizedHigh.toFixed(2)} prior to that. It has since dropped {dipPercentage}% to its current price. This could indicate an oversold bounce opportunity if the underlying fundamentals remain strong despite the recent negative catalysts found in the news.</>
                                )}
                            </p>
                            <div className={scoreClass} style={{ marginTop: '1.5rem', padding: '1rem', background: scoreBg, borderRadius: '8px', border: `1px solid ${scoreColor}` }}>
                                <strong className="flex-center" style={{ gap: '0.5rem', justifyContent: 'flex-start', color: scoreColor }}>
                                    <ArrowUpRight size={18} /> {isZombie ? `Zombie Classification Score: ${recoveryScore}/100` : `Recovery Probability Rating: ${recoveryScore}/100`}
                                </strong>
                            </div>
                        </div>

                        <div className="glass-panel" style={{ padding: '2rem' }}>
                            <h3 style={{ marginTop: 0 }}>Latest News Explaining the Dip</h3>
                            {news.length === 0 ? (
                                <p className="text-muted">No recent news found.</p>
                            ) : (
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    {news.map((item, idx) => (
                                        <li key={idx} style={{ padding: '1rem', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' }}>
                                            <div className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>{item.time}</div>
                                            <h4 style={{ margin: '0 0 0.5rem 0' }}>
                                                <a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--text-main)', textDecoration: 'none' }}
                                                    onMouseEnter={(e) => e.target.style.color = 'var(--primary)'}
                                                    onMouseLeave={(e) => e.target.style.color = 'var(--text-main)'}>
                                                    {item.title}
                                                </a>
                                            </h4>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </>
            )}
            <style>{`
                @keyframes spin { 100% { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
};

export default StockDetails;
