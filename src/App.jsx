import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { HashRouter as Router, Routes, Route, NavLink } from 'react-router-dom'
import { Activity, LayoutDashboard, Settings, Palette, Trophy, Compass, Droplet, ChartNoAxesCombined, ArrowUpRight } from 'lucide-react'
import './App.css'
import { getLocalNewsHeadlines } from './utils/telemetry'
import { SettingsProvider } from './state/settings.jsx'
import { useSettings } from './state/settingsContext.js'
import { THEMES, DEFAULT_SETTINGS } from './state/settingsSchema.js'

import Dashboard from './pages/Dashboard'
import LiveAlerts from './components/LiveAlerts'

const StockDetails = lazy(() => import('./pages/StockDetails'));
const ETFAwards = lazy(() => import('./pages/ETFAwards'));
const Discovery = lazy(() => import('./pages/Discovery'));
const OilWatch = lazy(() => import('./pages/OilWatch'));
const Futures = lazy(() => import('./pages/Futures'));
const SettingsPage = lazy(() => import('./pages/Settings'));

const getSeverityLevel = (text) => {
  if (!text) return 'normal';
  const lower = text.toLowerCase();
  const severeWords = ['crash', 'plunge', 'crisis', 'dead', 'kill', 'blood', 'doom', 'disaster', 'warning', 'collapse', 'fail', 'emergency', 'panic', 'terror', 'threat', 'tragedy', 'fatal', 'down', 'loss'];
  return severeWords.some(w => lower.includes(w)) ? 'severe' : 'normal';
};

function Workspace() {
  const { settings, update } = useSettings();
  const theme = settings.appearance.theme;
  const setTheme = (next) => update('appearance.theme', next);
  const excludedSectors = settings.scanner.excludedSectors;
  const autoRefreshInterval = settings.scanner.refreshMinutes;

  const previousThemeRef = useRef(DEFAULT_SETTINGS.appearance.theme);
  const [globalFilter, setGlobalFilter] = useState(settings.scanner.defaultRating);

  useEffect(() => {
    document.body.className = theme;
    if (theme !== 'theme-seizure') previousThemeRef.current = theme;
  }, [theme]);

  // 20 Second Reversion & Audio Control for Seizure Mode
  useEffect(() => {
    let timer;
    let audioCtx;
    let oscillators = [];

    if (theme === 'theme-seizure') {
      timer = setTimeout(() => {
        setTheme(previousThemeRef.current || DEFAULT_SETTINGS.appearance.theme);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

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
                  {THEMES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
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
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
          </Suspense>
        </main>

        <LiveAlerts />
      </div>
    </Router>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <Workspace />
    </SettingsProvider>
  )
}
