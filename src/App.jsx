import { useState, useEffect, useRef } from 'react'
import { HashRouter as Router, Routes, Route, Link } from 'react-router-dom'
import { Activity, LayoutDashboard, Settings, Palette, Trophy, Compass } from 'lucide-react'
import './App.css'
import { getLocalNewsHeadlines } from './utils/telemetry'

// Placeholder components
import Dashboard from './pages/Dashboard'
import StockDetails from './pages/StockDetails'
import ETFAwards from './pages/ETFAwards'
import Discovery from './pages/Discovery'
import LiveAlerts from './components/LiveAlerts'

const SECTORS = [
  { id: 'basicmaterials', label: 'Basic Materials' },
  { id: 'communicationservices', label: 'Communication Services' },
  { id: 'consumercyclical', label: 'Consumer Cyclical' },
  { id: 'consumerdefensive', label: 'Consumer Defensive' },
  { id: 'energy', label: 'Energy' },
  { id: 'financial', label: 'Financial' },
  { id: 'healthcare', label: 'Healthcare' },
  { id: 'industrials', label: 'Industrials' },
  { id: 'realestate', label: 'Real Estate' },
  { id: 'technology', label: 'Technology' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'photonics', label: 'Custom: Photonics Basket' }
];

const SettingsPage = ({ excludedSectors, setExcludedSectors, autoRefreshInterval, setAutoRefreshInterval }) => {
  const toggleSector = (id) => {
    if (excludedSectors.includes(id)) {
      setExcludedSectors(excludedSectors.filter(s => s !== id));
    } else {
      setExcludedSectors([...excludedSectors, id]);
    }
  };

  return (
    <div className="settings" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2>Scanner Settings</h2>
      <p className="text-muted" style={{ marginBottom: '2rem' }}>Configure your stock screener preferences and ignored sectors.</p>

      <div className="glass-panel" style={{ padding: '2rem' }}>
        <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Omitted Sectors</h3>
        <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1.5rem' }}>
          Check any sectors below to completely exclude them from your "Any Sector" broad market searches.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          {SECTORS.map(sector => (
            <label key={sector.id} className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={excludedSectors.includes(sector.id)}
                onChange={() => toggleSector(sector.id)}
                style={{
                  accentColor: 'var(--primary)',
                  width: '16px',
                  height: '16px',
                  cursor: 'pointer'
                }}
              />
              <span style={{ color: excludedSectors.includes(sector.id) ? 'var(--danger)' : 'var(--text-main)' }}>
                {sector.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="glass-panel" style={{ padding: '2rem', marginTop: '2rem' }}>
        <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Auto-Refresh Interval</h3>
        <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1.5rem' }}>
          Automatically refresh the dashboard stock ticker data every set number of minutes.
        </p>

        <select
          value={autoRefreshInterval}
          onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
          style={{
            padding: '0.75rem',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'var(--text-main)',
            borderRadius: '6px',
            fontFamily: 'inherit',
            outline: 'none',
            cursor: 'pointer'
          }}
        >
          <option value={0}>Off (Manual Only)</option>
          <option value={1}>Every 1 Minute</option>
          <option value={15}>Every 15 Minutes</option>
          <option value={30}>Every 30 Minutes</option>
        </select>
      </div>
    </div>
  )
}

const getSeverityLevel = (text) => {
  if (!text) return 'normal';
  const lower = text.toLowerCase();
  const severeWords = ['crash', 'plunge', 'crisis', 'dead', 'kill', 'blood', 'doom', 'disaster', 'warning', 'collapse', 'fail', 'emergency', 'panic', 'terror', 'threat', 'tragedy', 'fatal', 'down', 'loss'];
  return severeWords.some(w => lower.includes(w)) ? 'severe' : 'normal';
};

function App() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('dipAnalyzerTheme');
    if (saved === 'theme-seizure') return 'theme-majestic';
    return saved || 'theme-majestic';
  });

  const previousThemeRef = useRef('theme-majestic');

  const [excludedSectors, setExcludedSectors] = useState(() => {
    const saved = localStorage.getItem('excludedSectors');
    return saved ? JSON.parse(saved) : [];
  });
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(() => {
    const saved = localStorage.getItem('autoRefreshInterval');
    return saved ? JSON.parse(saved) : 0;
  });
  
  const [globalFilter, setGlobalFilter] = useState('All');

  // Ensure Majestic is the absolute default, ignore saved non-majestic themes.
  useEffect(() => {
    if (theme !== 'theme-majestic' && theme !== 'theme-seizure' && theme !== 'theme-anime') {
      setTimeout(() => setTheme('theme-majestic'), 0);
    }
    document.body.className = theme;
    // Don't persist seizure mode so it doesn't terrify someone on next startup
    if (theme !== 'theme-seizure') {
      localStorage.setItem('dipAnalyzerTheme', theme);
      previousThemeRef.current = theme;
    }
  }, [theme]);

  // 20 Second Reversion & Audio Control for Seizure Mode
  useEffect(() => {
    let timer;
    let audioCtx;
    let oscillators = [];

    if (theme === 'theme-seizure') {
      timer = setTimeout(() => {
        setTheme(previousThemeRef.current || 'theme-majestic');
      }, 20000);

      // Play continuous ambient, creepy low-volume drone
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.05; // Very subtle, not loud
        gainNode.connect(audioCtx.destination);

        // Sinister chord (Sub-bass and dissonant low mids)
        const frequencies = [45, 55, 65.41, 110];
        
        frequencies.forEach(freq => {
          const osc = audioCtx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = freq;
          
          // LFO to create a wobbling, uneasy feeling
          const lfo = audioCtx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = Math.random() * 3 + 0.5; // 0.5Hz to 3.5Hz wobble
          
          const lfoGain = audioCtx.createGain();
          lfoGain.gain.value = 3; // frequency variation
          
          lfo.connect(lfoGain);
          lfoGain.connect(osc.frequency);
          
          osc.connect(gainNode);
          osc.start();
          lfo.start();
          oscillators.push(osc, lfo);
        });
      } catch (err) {
        console.error("Audio API blocked or failed.", err);
      }
    }

    return () => {
      if (timer) clearTimeout(timer);
      if (audioCtx) {
        oscillators.forEach(osc => {
          try { osc.stop(); } catch { /* ignore */ }
        });
        audioCtx.close();
      }
    };
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('excludedSectors', JSON.stringify(excludedSectors));
  }, [excludedSectors]);

  useEffect(() => {
    localStorage.setItem('autoRefreshInterval', JSON.stringify(autoRefreshInterval));
  }, [autoRefreshInterval]);

  // Cryptic Telemetry (Local News logic)
  const [telemetryData, setTelemetryData] = useState([]);
  const [currentLine, setCurrentLine] = useState(0);

  useEffect(() => {
    let timeoutId;
    let isActive = true;

    if (theme === 'theme-seizure') {
      getLocalNewsHeadlines().then(lines => {
        if (!isActive) return;
        setTelemetryData(lines);
        setCurrentLine(0);
        // Swap out text slowly to allow reading (hallucinatory crawl)
        const swapLine = () => {
          if (!isActive) return;
          setCurrentLine(prev => (prev + 1) % lines.length);
          timeoutId = setTimeout(swapLine, 7500); // 7.5 seconds per headline
        };
        timeoutId = setTimeout(swapLine, 7500);
      });
    } else {
      setTimeout(() => {
        if (!isActive) return;
        setTelemetryData([]);
        setCurrentLine(0);
      }, 0);
    }

    return () => {
      isActive = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [theme]);

  return (
    <Router>
      <div className="app-container">

        {/* DOOMSDAY OVERLAY */}
        {theme === 'theme-seizure' && telemetryData.length > 0 && (
          <div className="telemetry-overlay">
            <h1 
              key={currentLine} 
              className={`telemetry-text severity-${getSeverityLevel(telemetryData[currentLine])}`}
            >
              {telemetryData[currentLine]}
            </h1>
          </div>
        )}

        <header className="flex-between glass-panel" style={{ padding: '1rem 2rem', marginBottom: '2rem' }}>
          <div className="logo flex-center" style={{ gap: '0.5rem' }}>
            <Activity color="var(--primary)" />
            <span className="text-gradient" style={{ fontFamily: 'var(--font-heading)', fontWeight: '700', fontSize: '1.2rem' }}>
              DipAnalyzer Pro
            </span>
          </div>
          <nav style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
            <div className="flex-center" style={{ gap: '0.5rem', marginRight: '1rem' }}>
              <select
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                style={{
                  background: 'black',
                  border: '1px solid rgba(255,255,255,0.2)',
                  color: 'white',
                  padding: '0.4rem 0.6rem',
                  borderRadius: '4px',
                  outline: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: '0.85rem'
                }}
              >
                <option value="All">All Ratings</option>
                <option value="Strong Buy">Strong Buy</option>
                <option value="Buy">Buy</option>
                <option value="Hold">Hold</option>
                <option value="Sell">Sell/Strong Sell</option>
                <option value="Bullish">Bullish</option>
                <option value="Bearish">Bearish</option>
              </select>
            </div>
            <div className="flex-center" style={{ gap: '0.5rem', color: 'var(--text-muted)', marginRight: '1rem' }}>
              <Palette size={16} />
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-main)',
                  outline: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: '0.9rem'
                }}
              >
                <option value="theme-majestic">Majestic</option>
                <option value="theme-anime">Alien Fractal</option>
                <option value="theme-seizure">Seizure Mode</option>
              </select>
            </div>
            <Link to="/" className="nav-link flex-center">
              <LayoutDashboard size={18} /> Dashboard
            </Link>
            <Link to="/etfs" className="nav-link flex-center">
              <Trophy size={18} /> Daily ETFs
            </Link>
            <Link to="/discovery" className="nav-link flex-center">
              <Compass size={18} /> Discovery
            </Link>
            <Link to="/settings" className="nav-link flex-center text-muted">
              <Settings size={18} /> Settings
            </Link>
          </nav>
        </header>

        <main>
          <Routes>
            <Route path="/" element={<Dashboard excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/stock/:symbol" element={<StockDetails />} />
            <Route path="/etfs" element={<ETFAwards excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/discovery" element={<Discovery excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/settings" element={<SettingsPage excludedSectors={excludedSectors} setExcludedSectors={setExcludedSectors} autoRefreshInterval={autoRefreshInterval} setAutoRefreshInterval={setAutoRefreshInterval} />} />
          </Routes>
        </main>
        
        <LiveAlerts />
      </div>
    </Router>
  )
}

export default App
