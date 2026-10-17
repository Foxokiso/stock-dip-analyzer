import { TrendingDown, Clock, Activity } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getVerdict } from '../utils/scoring';
import { formatPrice, formatPct } from '../utils/format';
import '../styles/components.css';

// Verdict label → semantic variant; the tones live in components.css.
const VARIANT_FOR_LABEL = { 'Strong Buy': 'strong-buy', Buy: 'buy', Hold: 'hold', Sell: 'sell', 'Strong Sell': 'strong-sell' };

const StockCard = ({ symbol, name, price, dipPercentage, recoveryProbability, isZombie }) => {
    const verdict = getVerdict(recoveryProbability, Boolean(isZombie));
    const scoreText = verdict ? verdict.label : 'Unavailable';
    const variant = !verdict ? 'none' : isZombie ? 'muted' : (VARIANT_FOR_LABEL[verdict.label] || 'muted');
    const pulse = Boolean(verdict) && !isZombie;

    return (
        <Link to={`/stock/${symbol}`} className={`stock-card glass-panel${isZombie ? ' stock-card--zombie' : ''}`}>
            <div className="flex-between stock-card-head">
                <div>
                    <h3 className="stock-card-symbol">{symbol}</h3>
                    <span className="stock-card-name">{name}</span>
                </div>
                <div className="stock-card-quote">
                    <div className="stock-card-price">{formatPrice(price)}</div>
                    <div className="stock-card-dip">
                        <TrendingDown size={14} aria-hidden="true" />
                        {formatPct(dipPercentage)}
                    </div>
                </div>
            </div>

            {/* Mini chart area (no series yet) */}
            <div className="stock-card-chart" aria-hidden="true">
                <Activity size={20} />
            </div>

            <div className="flex-between stock-card-foot">
                <div className="stock-card-since">
                    <Clock size={14} aria-hidden="true" /> Since Peak
                </div>
                <div className={`stock-card-score stock-card-score--${variant}`}>
                    <span className={`stock-card-dot${pulse ? ' stock-card-dot--pulse' : ''}`} aria-hidden="true" />
                    <span>
                        {scoreText}{recoveryProbability != null ? ` (${recoveryProbability})` : ''}
                    </span>
                </div>
            </div>
        </Link>
    );
};

export default StockCard;
