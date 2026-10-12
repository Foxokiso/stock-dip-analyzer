import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { HashRouter as Router, Routes, Route, NavLink } from 'react-router-dom'
import { Activity, LayoutDashboard, Settings, Palette, Trophy, Compass, Droplet, ChartNoAxesCombined, ArrowUpRight } from 'lucide-react'
import './App.css'
import { getLocalNewsHeadlines } from './utils/telemetry'

import Dashboard from './pages/Dashboard'
import LiveAlerts from './components/LiveAlerts'

const StockDetails = lazy(() => import('./pages/StockDetails'));
const ETFAwards = lazy(() => import('./pages/ETFAwards'));
const Discovery = lazy(() => import('./pages/Discovery'));
const OilWatch = lazy(() => import('./pages/OilWatch'));
const Futures = lazy(() => import('./pages/Futures'));

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
        gainNode.gain.value = 0.15; // Balanced volume
        gainNode.connect(audioCtx.destination);

        // 297 Hz fundamental and 27 Hz subharmonic
        const frequencies = [
          { freq: 297, type: 'triangle', gain: 0.2 }, // Whistle-like fundamental
          { freq: 27, type: 'sine', gain: 1.0 }        // Sub-bass 11th subharmonic
        ];
        
        frequencies.forEach(({ freq, type, gain }) => {
          const osc = audioCtx.createOscillator();
          osc.type = type;
          osc.frequency.value = freq;

          const indivGain = audioCtx.createGain();
          indivGain.gain.value = gain;
          
          // LFO to create a wobbling, uneasy feeling
          const lfo = audioCtx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = 0.2; // Very slow breathing wobble
          
          const lfoGain = audioCtx.createGain();
          lfoGain.gain.value = freq * 0.015; // subtle pitch variation
          
          lfo.connect(lfoGain);
          lfoGain.connect(osc.frequency);
          
          osc.connect(indivGain);
          indivGain.connect(gainNode);
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
        if (lines.length === 0) return;
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

        <header className="workspace-header">
          <div className="workspace-topbar">
            <NavLink to="/" className="workspace-brand" aria-label="Dip Analyzer home">
              <span className="brand-mark"><Activity size={22} /></span>
              <span><strong>dip<span className="brand-light">analyzer</span><sup>PRO</sup></strong><small>Market intelligence workspace</small></span>
            </NavLink>
            <div className="workspace-preferences">
              <span className="workspace-source-note"><span className="status-dot" />Source timing disclosed</span>
              <label className="compact-select"><span>Ratings</span>
                <select aria-label="Global rating filter" value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)}>
                  <option value="All">All Ratings</option>
                  <option value="Strong Buy">Strong Buy</option>
                  <option value="Buy">Buy</option>
                  <option value="Hold">Hold</option>
                  <option value="Sell/Strong Sell">Sell / Strong Sell</option>
                  <option value="Bullish">Bullish</option>
                  <option value="Bearish">Bearish</option>
                </select>
              </label>
              <label className="compact-select theme-select"><Palette size={14} />
                <select aria-label="Visual theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
                  <option value="theme-majestic">Modern</option>
                  <option value="theme-anime">Alien Fractal</option>
                  <option value="theme-seizure">Seizure Mode</option>
                </select>
              </label>
            </div>
          </div>
          <nav className="workspace-nav" aria-label="Main navigation">
            <NavLink to="/" end className="nav-link"><LayoutDashboard size={16} />Overview</NavLink>
            <NavLink to="/futures" className="nav-link"><ChartNoAxesCombined size={16} />Futures<span className="nav-new">NEW</span></NavLink>
            <NavLink to="/etfs" className="nav-link"><Trophy size={16} />ETF rankings</NavLink>
            <NavLink to="/oil" className="nav-link"><Droplet size={16} />Oil Watch</NavLink>
            <NavLink to="/discovery" className="nav-link"><Compass size={16} />Discovery</NavLink>
            <NavLink to="/settings" className="nav-link nav-settings"><Settings size={16} />Settings</NavLink>
          </nav>
        </header>

        <main>
          <Suspense fallback={<div className="desk-empty" role="status">Opening workspace…</div>}>
          <Routes>
            <Route path="/" element={<>
              <div className="overview-intro"><div><div className="eyebrow">YOUR RESEARCH DESK</div><span>Find the dip. Understand the context.</span></div><NavLink to="/futures">Explore the futures desk <ArrowUpRight size={16} /></NavLink></div>
              <Dashboard excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />
            </>} />
            <Route path="/futures" element={<Futures autoRefreshInterval={autoRefreshInterval} />} />
            <Route path="/stock/:symbol" element={<StockDetails autoRefreshInterval={autoRefreshInterval} />} />
            <Route path="/etfs" element={<ETFAwards excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/oil" element={<OilWatch autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/discovery" element={<Discovery excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/settings" element={<SettingsPage excludedSectors={excludedSectors} setExcludedSectors={setExcludedSectors} autoRefreshInterval={autoRefreshInterval} setAutoRefreshInterval={setAutoRefreshInterval} />} />
          </Routes>
          </Suspense>
        </main>
        
        <LiveAlerts />
      </div>
    </Router>
  )
}

export default App
