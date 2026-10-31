import { useState, useEffect, useLayoutEffect, useRef, Suspense } from 'react'
import { HashRouter as Router, Routes, Route, NavLink, useLocation, matchPath } from 'react-router-dom'
import { Activity, LayoutDashboard, Settings, Palette, Trophy, Compass, Droplet, ChartNoAxesCombined, ArrowUpRight, VolumeX } from 'lucide-react'
import './App.css'
import { getLocalNewsHeadlines } from './utils/telemetry'
import { preloadable } from './utils/preloadable.js'
import { SettingsProvider } from './state/settings.jsx'
import { useSettings } from './state/settingsContext.js'
import { THEMES, DEFAULT_SETTINGS, RATING_FILTERS, isTransientTheme } from './state/settingsSchema.js'
import ErrorBoundary, { ErrorPanel } from './components/ErrorBoundary.jsx'

import Dashboard from './pages/Dashboard'
import LiveAlerts from './components/LiveAlerts'
// The desks ship in the main bundle: the app loads from local disk, so code
// splitting saved nothing at startup and cost a Suspense fallback (plus React's
// 300 ms fallback throttle) on every first visit to a route.
import Futures from './pages/Futures'
import ETFAwards from './pages/ETFAwards'
import Discovery from './pages/Discovery'
import OilWatch from './pages/OilWatch'
import SettingsPage from './pages/Settings'
import NotFound from './pages/NotFound'

// Only the stock page carries the charting library; it is warmed during idle
// time right after startup so clicking a row never waits on it.
const StockDetails = preloadable(() => import('./pages/StockDetails'));

const RATING_LABELS = { All: 'All Ratings', 'Sell/Strong Sell': 'Sell / Strong Sell' };
// Seizure Mode drone master gain: its original 0.15 at the default alert
// volume and above (never louder than it was), proportionally quieter below.
const DRONE_GAIN = 0.15;
const droneGain = (volume) => DRONE_GAIN * Math.min(1, volume / DEFAULT_SETTINGS.alerts.volume);

// Window title per desk: "Overview — Dip Analyzer PRO", "AAPL — Stock — Dip Analyzer PRO".
const APP_TITLE = 'Dip Analyzer PRO';
const DESK_TITLES = [['/', 'Overview'], ['/futures', 'Futures'], ['/etfs', 'ETF rankings'], ['/oil', 'Oil Watch'], ['/discovery', 'Discovery'], ['/settings', 'Settings']];
const deskTitle = (pathname) => {
  const stock = matchPath('/stock/:symbol', pathname);
  if (stock) return `${stock.params.symbol} — Stock`;
  return DESK_TITLES.find(([path]) => matchPath(path, pathname))?.[1] ?? 'Page not found';
};

const getSeverityLevel = (text) => {
  if (!text) return 'normal';
  const lower = text.toLowerCase();
  const severeWords = ['crash', 'plunge', 'crisis', 'dead', 'kill', 'blood', 'doom', 'disaster', 'warning', 'collapse', 'fail', 'emergency', 'panic', 'terror', 'threat', 'tragedy', 'fatal', 'down', 'loss'];
  return severeWords.some(w => lower.includes(w)) ? 'severe' : 'normal';
};

// Error fallbacks: the whole workspace (outside the router), one desk (the
// header and navigation stay usable) and the alert layer.
const WorkspaceError = (props) => <div className="app-container"><ErrorPanel title="Dip Analyzer PRO hit an error" {...props} /></div>;
// Leaving a failed desk for the Overview is a route change, which resets the
// desk's boundary; on the Overview itself there is none, so the panel resets.
function DeskError(props) {
  const { pathname } = useLocation();
  return <ErrorPanel title="This desk hit an error" resetsOnNavigation={pathname !== '/'} {...props} />;
}
const AlertsError = () => (
  <p className="alerts-error" role="alert">
    Alerts stopped after an error.
    <button type="button" className="btn btn-outline" onClick={() => window.location.reload()}>Reload</button>
  </p>
);

// The routed desk. Its boundary resets when the route changes.
function Desk({ excludedSectors, autoRefreshInterval, globalFilter }) {
  const { pathname } = useLocation();
  const mainRef = useRef(null);
  const announcedPath = useRef(pathname);

  // Name the window after the desk. After a route change (not on the first
  // load, and not again for the same desk) focus moves to the new desk so
  // keyboard and screen-reader users start there. focus() itself does not
  // scroll; with focus in the desk, Chromium's scroll anchoring may then shift
  // the offset while the desk fills in, which keeps the content in view
  // steadier than it would be without the focus.
  useEffect(() => {
    document.title = `${deskTitle(pathname)} — ${APP_TITLE}`;
    if (announcedPath.current === pathname) return;
    announcedPath.current = pathname;
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <main ref={mainRef} tabIndex={-1}>
      <ErrorBoundary resetKey={pathname} fallback={DeskError}>
        <Suspense fallback={<div className="desk-empty" role="status">Opening workspace…</div>}>
          <Routes>
            <Route path="/" element={<>
              <div className="overview-intro"><div><div className="eyebrow"><span className="eyebrow-line" aria-hidden="true" />YOUR RESEARCH DESK</div><span>Find the dip. Understand the context.</span></div><NavLink to="/futures">Explore the futures desk <ArrowUpRight size={16} aria-hidden="true" /></NavLink></div>
              <Dashboard excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />
            </>} />
            <Route path="/futures" element={<Futures autoRefreshInterval={autoRefreshInterval} />} />
            <Route path="/stock/:symbol" element={<StockDetails autoRefreshInterval={autoRefreshInterval} />} />
            <Route path="/etfs" element={<ETFAwards excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/oil" element={<OilWatch autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/discovery" element={<Discovery excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

function Workspace() {
  const { settings, update } = useSettings();
  const theme = settings.appearance.theme;
  const setTheme = (next) => update('appearance.theme', next);
  const excludedSectors = settings.scanner.excludedSectors;
  const autoRefreshInterval = settings.scanner.refreshMinutes;
  const defaultRating = settings.scanner.defaultRating;

  // The theme class itself is applied to <html> and <body> by SettingsProvider;
  // this only remembers where to return after the Seizure Mode stunt.
  const previousThemeRef = useRef(DEFAULT_SETTINGS.appearance.theme);
  useEffect(() => {
    if (theme !== 'theme-seizure') previousThemeRef.current = theme;
  }, [theme]);

  // The header filter starts from, and follows, Settings → Scanner → default rating.
  const [globalFilter, setGlobalFilter] = useState(defaultRating);
  useEffect(() => { setGlobalFilter(defaultRating); }, [defaultRating]);

  // Warm the stock page chunk once the first paint and the initial scan requests are out.
  useEffect(() => {
    const warm = () => { StockDetails.preload().catch(() => { /* not cached: the first visit imports again */ }); };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, []);

  // Seizure Mode starts only from its confirmation, which carries the
  // photosensitivity warning. The header select does not list it; a control
  // that still selects it directly (the Settings theme cards, where arrowing
  // checks each card in turn) gets the warning instead and the theme stays.
  const seizureConfirm = useRef(null);
  const seizureConfirmed = useRef(false);
  useLayoutEffect(() => {
    if (theme !== 'theme-seizure') {
      seizureConfirmed.current = false;
      return;
    }
    if (seizureConfirmed.current) return;
    update('appearance.theme', previousThemeRef.current);
    if (!seizureConfirm.current?.open) seizureConfirm.current?.showModal();
  }, [theme, update]);

  const [droneMuted, setDroneMuted] = useState(false);
  const startSeizureMode = () => {
    seizureConfirmed.current = true;
    seizureConfirm.current?.close();
    setDroneMuted(false);
    setTheme('theme-seizure');
  };
  const endSeizureMode = () => setTheme(previousThemeRef.current);

  // 20 Second Reversion
  useEffect(() => {
    if (theme !== 'theme-seizure' || !seizureConfirmed.current) return undefined;
    const timer = setTimeout(() => update('appearance.theme', previousThemeRef.current), 20000);
    return () => clearTimeout(timer);
  }, [theme, update]);

  // The drone follows Settings → Alerts → Sound and Volume (the volume can
  // only turn it down, see droneGain) and the mode's own Mute control.
  const droneVolume = settings.alerts.sound ? settings.alerts.volume : 0;
  useEffect(() => {
    if (theme !== 'theme-seizure' || !seizureConfirmed.current || droneMuted || droneVolume <= 0) return undefined;
    let audioCtx;
    const oscillators = [];

    // Play continuous ambient, creepy low-volume drone
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContext();

      const gainNode = audioCtx.createGain();
      gainNode.gain.value = droneGain(droneVolume);
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

    return () => {
      if (audioCtx) {
        oscillators.forEach(osc => {
          try { osc.stop(); } catch { /* ignore */ }
        });
        audioCtx.close();
      }
    };
  }, [theme, droneMuted, droneVolume]);

  // Cryptic Telemetry (Local News logic)
  const [telemetryData, setTelemetryData] = useState([]);
  const [currentLine, setCurrentLine] = useState(0);

  useEffect(() => {
    let timeoutId;
    let isActive = true;

    if (theme === 'theme-seizure' && seizureConfirmed.current) {
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

        {/* DOOMSDAY OVERLAY: decoration, so it is hidden from assistive technology */}
        {theme === 'theme-seizure' && telemetryData.length > 0 && (
          <div className="telemetry-overlay" aria-hidden="true">
            <p
              key={currentLine}
              className={`telemetry-text severity-${getSeverityLevel(telemetryData[currentLine])}`}
            >
              {telemetryData[currentLine]}
            </p>
          </div>
        )}
        {theme === 'theme-seizure' && (
          <div className="seizure-controls" role="group" aria-label="Seizure Mode">
            {droneVolume > 0 && (
              <button type="button" className="btn btn-outline" aria-pressed={droneMuted} onClick={() => setDroneMuted(muted => !muted)}>
                <VolumeX size={15} aria-hidden="true" />Mute drone
              </button>
            )}
            <button type="button" className="btn btn-outline" onClick={endSeizureMode}>End now</button>
          </div>
        )}

        <header className="workspace-header">
          <div className="workspace-topbar">
            <NavLink to="/" className="workspace-brand">
              <span className="brand-mark" aria-hidden="true"><Activity size={22} /></span>
              <span className="brand-text"><strong>dip<span className="brand-light">analyzer</span> <sup>PRO</sup></strong><small>Market intelligence workspace</small></span>
            </NavLink>
            <div className="workspace-preferences">
              <span className="workspace-source-note"><span className="status-dot" aria-hidden="true" />Source timing disclosed</span>
              <label className="compact-select"><span>Ratings</span>
                <select value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)}>
                  {RATING_FILTERS.map(item => <option key={item} value={item}>{RATING_LABELS[item] ?? item}</option>)}
                </select>
              </label>
              <label className="compact-select theme-select"><Palette size={14} aria-hidden="true" /><span>Theme</span>
                {/* Arrowing through a closed select applies each option, so the
                    transient Seizure Mode is listed only while it runs. */}
                <select aria-label="Visual theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
                  {THEMES.filter(item => !isTransientTheme(item.id) || item.id === theme).map(item => (
                    <option key={item.id} value={item.id} disabled={isTransientTheme(item.id)}>{item.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <nav className="workspace-nav" aria-label="Main navigation">
            <NavLink to="/" end className="nav-link"><LayoutDashboard size={16} aria-hidden="true" />Overview</NavLink>
            <NavLink to="/futures" className="nav-link"><ChartNoAxesCombined size={16} aria-hidden="true" />Futures<span className="nav-new">NEW</span></NavLink>
            <NavLink to="/etfs" className="nav-link"><Trophy size={16} aria-hidden="true" />ETF rankings</NavLink>
            <NavLink to="/oil" className="nav-link"><Droplet size={16} aria-hidden="true" />Oil Watch</NavLink>
            <NavLink to="/discovery" className="nav-link"><Compass size={16} aria-hidden="true" />Discovery</NavLink>
            <NavLink to="/settings" className="nav-link nav-settings"><Settings size={16} aria-hidden="true" />Settings</NavLink>
          </nav>
        </header>

        <Desk excludedSectors={excludedSectors} autoRefreshInterval={autoRefreshInterval} globalFilter={globalFilter} />

        <ErrorBoundary fallback={AlertsError}>
          <LiveAlerts />
        </ErrorBoundary>

        <dialog ref={seizureConfirm} className="seizure-confirm glass-panel" aria-labelledby="seizure-confirm-title" aria-describedby="seizure-confirm-warning">
          <h2 id="seizure-confirm-title">Start Seizure Mode?</h2>
          <p id="seizure-confirm-warning">
            <strong>Photosensitivity warning.</strong> For 20 seconds the screen darkens and pulses, and large headlines fade in and out over every desk.{' '}
            {droneVolume > 0 ? 'A low drone plays, quieter if your alert volume is turned down; the mode has its own mute.' : 'It stays silent, because alert sound is off or at zero volume in Settings → Alerts.'}{' '}
            It ends by itself and is never saved.
          </p>
          <div className="seizure-confirm-actions">
            <button type="button" className="btn btn-outline" onClick={() => seizureConfirm.current?.close()}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={startSeizureMode}>Start Seizure Mode</button>
          </div>
        </dialog>
      </div>
    </Router>
  )
}

export default function App() {
  return (
    <ErrorBoundary fallback={WorkspaceError}>
      <SettingsProvider>
        <Workspace />
      </SettingsProvider>
    </ErrorBoundary>
  )
}
