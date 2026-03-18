import { TrendingUp, TrendingDown, Clock, Activity } from 'lucide-react';
import { Link } from 'react-router-dom';

const StockCard = ({ symbol, name, price, dipPercentage, recoveryProbability, isZombie }) => {
    let scoreColor = 'var(--text-muted)';
    let scoreText = 'Neutral Signal';
    let scoreClass = '';

    if (isZombie) {
        scoreColor = '#9ca3af'; // Improved contrast for dark themes
        scoreText = 'ZOMBIE / DEAD';
        scoreClass = '';
    } else if (recoveryProbability >= 80) {
        scoreColor = 'var(--success)';
        scoreText = 'Strong Buy';
        scoreClass = 'rating-pulse-success';
    } else if (recoveryProbability >= 60) {
        scoreColor = '#22c55e'; // A slightly different green for just "Buy"
        scoreText = 'Buy';
        scoreClass = 'rating-pulse-success'; // Reuse the pulse
    } else if (recoveryProbability >= 40) {
        scoreColor = 'var(--warning)';
        scoreText = 'Hold';
        scoreClass = 'rating-pulse-warning';
    } else if (recoveryProbability >= 20) {
        scoreColor = '#f97316'; // Orange for "Sell"
        scoreText = 'Sell';
        scoreClass = 'rating-pulse-warning'; 
    } else {
        scoreColor = 'var(--danger)';
        scoreText = 'Strong Sell';
        scoreClass = 'rating-pulse-danger';
    }

    return (
        <Link to={`/stock/${symbol}`} className="glass-panel" style={{
            display: 'block',
            padding: '1.5rem',
            textDecoration: 'none',
            color: 'inherit',
            transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s',
            opacity: isZombie ? 0.6 : 1,
            filter: isZombie ? 'grayscale(100%)' : 'none'
        }}
            onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-4px)';
                e.currentTarget.style.boxShadow = '0 12px 40px rgba(0, 242, 254, 0.15)';
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'var(--glass-shadow)';
            }}>
            <div className="flex-between" style={{ marginBottom: '1rem' }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-main)' }}>{symbol}</h3>
                    <span className="text-muted" style={{ fontSize: '0.85rem' }}>{name}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '1.2rem', fontWeight: '600' }}>${price.toFixed(2)}</div>
                    <div className="text-danger flex-center" style={{ gap: '0.25rem', fontSize: '0.9rem', justifyContent: 'flex-end' }}>
                        <TrendingDown size={14} />
                        {dipPercentage}%
                    </div>
                </div>
            </div>

            {/* Mini Chart Placeholder area */}
            <div style={{
                height: '60px',
                width: '100%',
                background: 'rgba(255,255,255,0.02)',
                borderRadius: '8px',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)'
            }}>
                <Activity size={20} style={{ opacity: 0.5 }} />
            </div>

            <div className="flex-between" style={{ fontSize: '0.85rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '1rem' }}>
                <div className="flex-center" style={{ gap: '0.3rem', color: 'var(--text-muted)' }}>
                    <Clock size={14} /> Since Peak
                </div>
                <div className="flex-center" style={{ gap: '0.4rem' }}>
                    <div className={scoreClass} style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: scoreColor,
                        boxShadow: `0 0 8px ${scoreColor}`
                    }} />
                    <span style={{ color: scoreColor }}>
                        {scoreText} ({recoveryProbability})
                    </span>
                </div>
            </div>
        </Link>
    );
};

export default StockCard;
