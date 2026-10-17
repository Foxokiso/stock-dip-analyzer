import { useState, useEffect, useMemo, useRef } from 'react';
import { History, X, TrendingUp, TrendingDown, AlertTriangle, Activity } from 'lucide-react';
import alienAudio from '../assets/alien_ominous.wav';
import { formatQuoteTime } from '../utils/format';
import { useSettings } from '../state/settingsContext.js';
import { DEFAULT_SETTINGS } from '../state/settingsSchema.js';
import '../styles/components.css';

const HISTORY_KEY = 'dipAnalyzerAlertHistory';
const TOAST_MS = 5000;
// Base levels from v1; Settings → Alerts → Volume multiplies them (master gain = volume × base).
const BASE_VOLUME = 0.25;      // HTMLAudio alert
const BASE_AMBER_GAIN = 0.03;  // synthesized amber-alert master gain

// Which Settings → Alerts toggle governs each alert type. Anything else is dropped
// before it renders or sounds.
const SETTING_FOR_TYPE = { breakout: 'breakout', breakdown: 'breakdown', bullish: 'trend', bearish: 'trend' };
const TAG_FOR_TYPE = { breakout: 'BREAKOUT', breakdown: 'BREAKDOWN', bullish: 'BULLISH', bearish: 'BEARISH' };

// Semantic tone: amber → warning, up moves → success, down moves → danger, else info.
const toneOf = ({ color, type }) => {
    if (color === 'amber') return 'warning';
    if (type === 'breakout' || type === 'bullish') return 'success';
    if (type === 'breakdown' || type === 'bearish') return 'danger';
    return 'info';
};
const tagOf = ({ color, type }) => (color === 'amber' ? 'AMBER ALERT' : TAG_FOR_TYPE[type] || String(type || 'alert').toUpperCase());
const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const historyLimitOf = (prefs) => (Number.isInteger(prefs?.historyLimit) && prefs.historyLimit > 0 ? prefs.historyLimit : DEFAULT_SETTINGS.alerts.historyLimit);
const openSymbol = (symbol) => { window.location.hash = `/stock/${symbol}`; };

const ToneIcon = ({ tone, size }) => {
    if (tone === 'warning') return <AlertTriangle size={size} aria-hidden="true" />;
    if (tone === 'success') return <TrendingUp size={size} aria-hidden="true" />;
    if (tone === 'danger') return <TrendingDown size={size} aria-hidden="true" />;
    return <Activity size={size} aria-hidden="true" />;
};

const loadHistory = () => {
    try {
        const saved = localStorage.getItem(HISTORY_KEY);
        if (!saved) return [];
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return [];
        const todayStr = new Date().toDateString();
        // Keep today's alerts, and amber alerts from any day.
        return parsed.filter(item => item.color === 'amber' || new Date(item.timestamp).toDateString() === todayStr);
    } catch (e) {
        console.error('Failed to parse alert history', e);
        return [];
    }
};

// Dynamic amber-alert audio: four discordant drones through a low-pass filter and a
// compressor. One AudioContext per alert, closed when the last tone ends, so StrictMode
// and the verify-alerts script see exactly one context per alert.
const playAmberAlertSound = (masterLevel, contexts) => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        contexts.add(ctx);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(350, ctx.currentTime); // muffle the piercing highs

        const compressor = ctx.createDynamicsCompressor();
        compressor.attack.setValueAtTime(0.120, ctx.currentTime);
        compressor.threshold.setValueAtTime(-24, ctx.currentTime);
        compressor.ratio.setValueAtTime(12, ctx.currentTime);
        compressor.connect(ctx.destination);

        filter.connect(compressor);

        const masterGain = ctx.createGain();
        masterGain.gain.value = masterLevel;
        masterGain.connect(filter);

        const createDrone = (type, freq, detune, duration, startTime) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            osc.detune.setValueAtTime(detune, ctx.currentTime);

            // Morph the frequency a little so the drone never sits still.
            const randomOffset = (Math.random() * 200) - 100;
            osc.frequency.linearRampToValueAtTime(freq + randomOffset, ctx.currentTime + duration / 2);
            osc.frequency.linearRampToValueAtTime(freq, ctx.currentTime + duration);

            // Swell in and out (no jump-scare).
            gain.gain.setValueAtTime(0, ctx.currentTime + startTime);
            gain.gain.linearRampToValueAtTime(1, ctx.currentTime + startTime + 0.5);
            gain.gain.setValueAtTime(1, ctx.currentTime + startTime + duration - 0.5);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + startTime + duration);

            osc.connect(gain);
            gain.connect(masterGain);

            osc.start(ctx.currentTime + startTime);
            osc.stop(ctx.currentTime + startTime + duration);
            return osc;
        };

        const baseTime = 0;
        const totalDuration = 2.5;
        createDrone('square', 853, 0, totalDuration, baseTime);                                  // high alarm
        createDrone('sawtooth', 960, 50, totalDuration, baseTime + 0.1);                         // dissonant harmonic
        createDrone('sine', 150, -25, totalDuration, baseTime + 0.2);                            // low rumble
        const finalTone = createDrone('triangle', 450 + (Math.random() * 300), 10, totalDuration, baseTime + 0.3); // unstable morph
        finalTone.onended = () => {
            contexts.delete(ctx);
            ctx.close().catch(() => {});
        };
    } catch (e) {
        console.error('Web Audio API not supported or thwarted:', e);
    }
};

const LiveAlerts = () => {
    const { settings } = useSettings();
    const alertSettings = settings.alerts;
    const [alerts, setAlerts] = useState([]); // active live toasts
    const [history, setHistory] = useState(loadHistory);
    const [showHistory, setShowHistory] = useState(false);

    const settingsRef = useRef(alertSettings);
    const audioRef = useRef(null);
    const activeSymbolsRef = useRef(new Set());
    const timersRef = useRef(new Set());
    const contextsRef = useRef(new Set());

    // The event handler is subscribed once (StrictMode-safe); it reads the live
    // settings through this ref instead of re-subscribing on every change.
    useEffect(() => {
        settingsRef.current = alertSettings;
    }, [alertSettings]);

    useEffect(() => {
        if (!audioRef.current) audioRef.current = new Audio(alienAudio);
    }, []);

    // Settings → Alerts → History length applies to what is shown and stored.
    const historyLimit = historyLimitOf(alertSettings);
    const visibleHistory = useMemo(() => (history.length > historyLimit ? history.slice(0, historyLimit) : history), [history, historyLimit]);

    useEffect(() => {
        if (visibleHistory.length > 0) {
            try {
                localStorage.setItem(HISTORY_KEY, JSON.stringify(visibleHistory));
            } catch {
                // Storage can be unavailable; the session still works.
            }
        }
    }, [visibleHistory]);

    useEffect(() => {
        const handleAlert = (e) => {
            const detail = e.detail || {};
            const { symbol, type, message, color = 'blue', timestamp = Date.now(), source, quotedAt, delayMinutes } = detail;
            const prefs = settingsRef.current;

            // Type gate: only breakout / breakdown / trend alerts the user has enabled.
            const gate = SETTING_FOR_TYPE[type];
            if (!gate || !prefs[gate]) return;
            // Score gate, where the emitter attached a score.
            const score = Number.isFinite(detail.score) ? detail.score : null;
            if (score != null && score < prefs.minScore) return;

            if (activeSymbolsRef.current.has(symbol)) return;
            activeSymbolsRef.current.add(symbol);

            const newAlert = { id: crypto.randomUUID(), symbol, type, message, color, timestamp, source, quotedAt, delayMinutes, score };
            setAlerts((prev) => [...prev, newAlert]);

            // Effects belong in the event handler, outside React's pure updater.
            const level = clamp01(prefs.volume);
            if (prefs.sound && level > 0) {
                if (color === 'amber') {
                    playAmberAlertSound(BASE_AMBER_GAIN * level, contextsRef.current);
                } else if (audioRef.current) {
                    audioRef.current.volume = BASE_VOLUME * level;
                    audioRef.current.currentTime = 0;
                    audioRef.current.play().catch(err => console.log('Audio play prevented', err));
                }
            }

            const limit = historyLimitOf(prefs);
            setHistory(prev => [newAlert, ...prev].slice(0, limit));

            // Auto dismiss this specific toast.
            const timer = setTimeout(() => {
                timersRef.current.delete(timer);
                activeSymbolsRef.current.delete(symbol);
                setAlerts((prev) => prev.filter(a => a.id !== newAlert.id));
            }, TOAST_MS);
            timersRef.current.add(timer);
        };

        window.addEventListener('stock-alert', handleAlert);
        const timers = timersRef.current;
        const contexts = contextsRef.current;
        const activeSymbols = activeSymbolsRef.current;
        return () => {
            window.removeEventListener('stock-alert', handleAlert);
            timers.forEach(clearTimeout);
            timers.clear();
            contexts.forEach(ctx => ctx.close().catch(() => {}));
            contexts.clear();
            activeSymbols.clear();
            audioRef.current?.pause();
        };
    }, []);

    const hasWarning = visibleHistory.some(h => h.color === 'amber');

    return (
        <>
            {/* Live toasts */}
            <div className="alert-stack">
                {alerts.map((alert) => {
                    const tone = toneOf(alert);
                    return (
                        <div key={alert.id} className={`alert-toast alert-toast--${tone}`} role="status">
                            <div className="alert-toast-head">
                                <button type="button" className="alert-symbol" onClick={() => openSymbol(alert.symbol)} title="View details">
                                    <ToneIcon tone={tone} size={14} />${alert.symbol}
                                </button>
                                <span className="alert-toast-tag">{tagOf(alert)}</span>
                            </div>
                            <div className="alert-toast-message">{alert.message}</div>
                        </div>
                    );
                })}
            </div>

            {/* History toggle */}
            <button
                type="button"
                className={`alert-history-toggle${hasWarning ? ' alert-history-toggle--warning' : ''}`}
                onClick={() => setShowHistory(open => !open)}
                title="Alert history"
                aria-label="Alert history"
                aria-expanded={showHistory}
            >
                <History size={24} aria-hidden="true" />
                {visibleHistory.length > 0 && <span className="alert-history-badge">{visibleHistory.length}</span>}
            </button>

            {/* History drawer */}
            {showHistory && (
                <aside className="alert-drawer" aria-label="Alert history">
                    <div className="alert-drawer-head">
                        <h2><History size={20} aria-hidden="true" /> Alert History</h2>
                        <button type="button" className="alert-drawer-close" onClick={() => setShowHistory(false)} aria-label="Close alert history">
                            <X size={20} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="alert-drawer-list">
                        {visibleHistory.length === 0 ? (
                            <div className="alert-drawer-empty">No alerts recorded yet.</div>
                        ) : (
                            visibleHistory.map((alert) => {
                                const tone = toneOf(alert);
                                return (
                                    <article key={alert.id} className={`alert-entry alert-entry--${tone}`}>
                                        <div className="alert-entry-head">
                                            <button
                                                type="button"
                                                className="alert-symbol"
                                                onClick={() => { openSymbol(alert.symbol); setShowHistory(false); }}
                                                title="View details"
                                            >
                                                <ToneIcon tone={tone} size={13} />${alert.symbol}
                                            </button>
                                            <span className="alert-entry-time">
                                                {new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <div className="alert-entry-message">{alert.message}</div>
                                        <div className="quote-meta alert-entry-meta">
                                            {alert.source || 'Legacy alert · source unknown'} · Quote: {formatQuoteTime(alert.quotedAt)}
                                            {Number.isFinite(alert.score) ? ` · Score ${alert.score}` : ''}
                                        </div>
                                    </article>
                                );
                            })
                        )}
                    </div>
                </aside>
            )}
        </>
    );
};

export default LiveAlerts;
