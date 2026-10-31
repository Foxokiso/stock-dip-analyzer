import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { History, X, TrendingUp, TrendingDown, AlertTriangle, Activity } from 'lucide-react';
// The 4 s WAV that src/scripts/generate_audio.py writes, encoded with
// `ffmpeg -i alien_ominous.wav -codec:a libmp3lame -q:a 6 alien_ominous.mp3`
// (ffmpeg 6.1.1 reproduces it byte for byte); the 353 KB WAV is not shipped.
import alienAudio from '../assets/alien_ominous.mp3';
import { formatQuoteTime } from '../utils/format';
import { useSettings } from '../state/settingsContext.js';
import { DEFAULT_SETTINGS } from '../state/settingsSchema.js';
import '../styles/components.css';

const HISTORY_KEY = 'dipAnalyzerAlertHistory';
const TOAST_MS = 5000;
// A scan can raise dozens of alerts at once: at most MAX_TOASTS are shown, and
// the rest of the burst collapses into one "+N more" toast that opens the history.
const MAX_TOASTS = 3;
// At most one alert sound per window, however many alerts arrive in it.
const SOUND_GAP_MS = 2000;
// Base levels from v1; Settings → Alerts → Volume multiplies them (master gain = volume × base).
const BASE_VOLUME = 0.25;      // HTMLAudio alert
const BASE_AMBER_GAIN = 0.03;  // synthesized amber-alert master gain

// Which Settings → Alerts toggle governs each alert type. Anything else is dropped
// before it renders or sounds.
const SETTING_FOR_TYPE = { breakout: 'breakout', breakdown: 'breakdown', bullish: 'trend', bearish: 'trend' };
const TAG_FOR_TYPE = { breakout: 'BREAKOUT', breakdown: 'BREAKDOWN', bullish: 'BULLISH', bearish: 'BEARISH' };
// The minimum score is a buy-side threshold. Breakdown and bearish warnings come
// from low-scoring setups, so they are raised whatever the score.
const SCORE_GATED_TYPES = new Set(['breakout', 'bullish']);
const allows = (prefs, type, score) => {
    // Type gate: only breakout / breakdown / trend alerts the user has enabled.
    const gate = SETTING_FOR_TYPE[type];
    if (!gate || !prefs[gate]) return false;
    // Score gate, buy side only, where the emitter attached a score.
    return !(SCORE_GATED_TYPES.has(type) && score !== null && score < prefs.minScore);
};

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

// Alerts come from window events and from stored history (older versions, hand
// edits), so every field that renders is checked here: an entry without a
// symbol is dropped, and anything else that is not text or a number is left out
// rather than reaching React as an object and blanking the window.
const text = (value) => (typeof value === 'string' ? value : null);
const finite = (value) => (Number.isFinite(value) ? value : null);
const toAlert = (item) => {
    if (!item || typeof item !== 'object' || !text(item.symbol)) return null;
    return {
        id: text(item.id) ?? crypto.randomUUID(),
        symbol: item.symbol,
        type: text(item.type),
        message: text(item.message) ?? '',
        color: item.color === 'amber' ? 'amber' : 'blue',
        timestamp: finite(item.timestamp),
        source: text(item.source),
        quotedAt: text(item.quotedAt),
        delayMinutes: finite(item.delayMinutes),
        score: finite(item.score),
    };
};

const loadHistory = () => {
    try {
        const saved = localStorage.getItem(HISTORY_KEY);
        if (!saved) return [];
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) return [];
        const todayStr = new Date().toDateString();
        // Keep today's alerts, and amber alerts from any day.
        return parsed.map(toAlert).filter(item => item
            && (item.color === 'amber' || (item.timestamp !== null && new Date(item.timestamp).toDateString() === todayStr)));
    } catch (e) {
        console.error('Failed to parse alert history', e);
        return [];
    }
};

// Dynamic amber-alert audio: four discordant drones through a low-pass filter and a
// compressor, scheduled on the one shared AudioContext (`getContext` creates it on
// the first amber alert). The chain is released when the last tone ends.
const playAmberAlertSound = (getContext, masterLevel) => {
    try {
        const ctx = getContext();

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
        finalTone.onended = () => compressor.disconnect();
    } catch (e) {
        console.error('Web Audio API not supported or thwarted:', e);
    }
};

const LiveAlerts = () => {
    const { settings } = useSettings();
    const alertSettings = settings.alerts;
    const [alerts, setAlerts] = useState([]); // active live toasts, at most MAX_TOASTS
    const [overflow, setOverflow] = useState(0); // alerts of the current burst beyond them
    const [history, setHistory] = useState(loadHistory);
    const [showHistory, setShowHistory] = useState(false);

    const settingsRef = useRef(alertSettings);
    const audioRef = useRef(null);        // the alert clip, created on the first non-amber sound
    const audioContextRef = useRef(null); // shared by every amber alert, created on the first one
    const lastSoundRef = useRef(-Infinity);
    const visibleRef = useRef(new Set()); // ids of the visible toasts, read synchronously by the handler
    const burstRef = useRef({ count: 0, timer: null });
    const timersRef = useRef(new Set());

    // The event handler is subscribed once (StrictMode-safe); it reads the live
    // settings through this ref instead of re-subscribing on every change.
    useEffect(() => {
        settingsRef.current = alertSettings;
    }, [alertSettings]);

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

    // Ends the "+N more" summary: its burst is over, or the history was opened.
    const clearOverflow = useCallback(() => {
        const burst = burstRef.current;
        if (burst.timer !== null) {
            clearTimeout(burst.timer);
            timersRef.current.delete(burst.timer);
        }
        burst.count = 0;
        burst.timer = null;
        setOverflow(0);
    }, []);

    const openHistory = () => {
        clearOverflow();
        setShowHistory(true);
    };

    useEffect(() => {
        const timers = timersRef.current;
        const visible = visibleRef.current;
        const later = (fn, ms) => {
            const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
            timers.add(timer);
            return timer;
        };
        // One AudioContext for every amber alert, created on the first one.
        const sharedAudioContext = () => {
            if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                audioContextRef.current = new AudioContext();
            }
            const ctx = audioContextRef.current;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return ctx;
        };

        const handleAlert = (e) => {
            const detail = e.detail || {};
            const prefs = settingsRef.current;

            // A scan's alert lists every condition that turned true together, in
            // precedence order. The first one these settings allow is shown, so a
            // type switched off never hides the next; other alerts name one condition.
            const score = finite(detail.score);
            const shown = (Array.isArray(detail.conditions) ? detail.conditions : [detail])
                .find(condition => condition && allows(prefs, condition.type, score));
            if (!shown) return;

            const newAlert = toAlert({ ...detail, type: shown.type, color: shown.color, message: shown.message, id: crypto.randomUUID(), timestamp: finite(detail.timestamp) ?? Date.now() });
            if (!newAlert) return;

            // The history keeps every alert, toasted or not, up to the history length.
            const limit = historyLimitOf(prefs);
            setHistory(prev => [newAlert, ...prev].slice(0, limit));

            if (visible.size < MAX_TOASTS) {
                visible.add(newAlert.id);
                setAlerts((prev) => [...prev, newAlert]);
                later(() => {
                    visible.delete(newAlert.id);
                    setAlerts((prev) => prev.filter(a => a.id !== newAlert.id));
                }, TOAST_MS);
            } else {
                // The summary stays up while the burst lasts and clears TOAST_MS after its last alert.
                const burst = burstRef.current;
                burst.count += 1;
                setOverflow(burst.count);
                if (burst.timer !== null) {
                    clearTimeout(burst.timer);
                    timers.delete(burst.timer);
                }
                burst.timer = later(clearOverflow, TOAST_MS);
            }

            // Effects belong in the event handler, outside React's pure updater.
            const level = clamp01(prefs.volume);
            const now = Date.now();
            if (prefs.sound && level > 0 && now - lastSoundRef.current >= SOUND_GAP_MS) {
                lastSoundRef.current = now;
                if (newAlert.color === 'amber') {
                    playAmberAlertSound(sharedAudioContext, BASE_AMBER_GAIN * level);
                } else {
                    // Created on the first sound: nothing is fetched or decoded at startup.
                    audioRef.current ??= new Audio(alienAudio);
                    audioRef.current.volume = BASE_VOLUME * level;
                    audioRef.current.currentTime = 0;
                    audioRef.current.play().catch(err => console.log('Audio play prevented', err));
                }
            }
        };

        window.addEventListener('stock-alert', handleAlert);
        return () => {
            window.removeEventListener('stock-alert', handleAlert);
            timers.forEach(clearTimeout);
            timers.clear();
            visible.clear();
            burstRef.current = { count: 0, timer: null };
            audioContextRef.current?.close().catch(() => {});
            audioContextRef.current = null;
            audioRef.current?.pause();
        };
    }, [clearOverflow]);

    const hasWarning = visibleHistory.some(h => h.color === 'amber');

    return (
        <>
            {/* Live toasts. One persistent live region announces each toast as it
                arrives; a status region inserted together with its text is often
                not read. Each toast is read whole, so is a changed "+N more". */}
            <div className="alert-stack" role="log" aria-label="Live alerts">
                {alerts.map((alert) => {
                    const tone = toneOf(alert);
                    return (
                        <div key={alert.id} className={`alert-toast alert-toast--${tone}`} aria-atomic="true">
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
                {overflow > 0 && (
                    <div className="alert-toast alert-toast--overflow" aria-atomic="true">
                        <button type="button" className="alert-overflow" onClick={openHistory}>
                            +{overflow} more alert{overflow === 1 ? '' : 's'} — open history
                        </button>
                    </div>
                )}
            </div>

            {/* History toggle, floating; the spacer keeps the end of the page clear of it. */}
            <div className="alert-history-spacer" aria-hidden="true" />
            <button
                type="button"
                className={`alert-history-toggle${hasWarning ? ' alert-history-toggle--warning' : ''}`}
                onClick={() => (showHistory ? setShowHistory(false) : openHistory())}
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
                                                {alert.timestamp === null ? '—' : new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
