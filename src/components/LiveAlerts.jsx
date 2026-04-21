import { useState, useEffect, useRef } from 'react';
import { History, X } from 'lucide-react';
import alienAudio from '../assets/alien_ominous.wav';

const LiveAlerts = () => {
    const [alerts, setAlerts] = useState([]); // active live toasts
    const [history, setHistory] = useState(() => {
        const saved = localStorage.getItem('dipAnalyzerAlertHistory');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                const now = new Date();
                const todayStr = now.toDateString();
                
                return parsed.filter(item => {
                    const itemDate = new Date(item.timestamp).toDateString();
                    if (itemDate === todayStr) return true;
                    if (item.color === 'amber') return true;
                    return false;
                });
            } catch (e) {
                console.error("Failed to parse alert history", e);
            }
        }
        return [];
    }); // all history
    const [showHistory, setShowHistory] = useState(false);
    
    const audioRef = useRef(null);

    // Dynamic Amber Alert Audio Generation
    const playAmberAlertSound = () => {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioContext();
            
            const masterGain = ctx.createGain();
            masterGain.gain.value = 0.3; // Volume
            masterGain.connect(ctx.destination);

            // Create 4 jarring oscillator sounds
            const createDrone = (type, freq, detune, duration, startTime) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                
                osc.type = type;
                osc.frequency.setValueAtTime(freq, ctx.currentTime);
                osc.detune.setValueAtTime(detune, ctx.currentTime);
                
                // Add some morphing/gliding to the frequency based on random values
                const randomOffset = (Math.random() * 200) - 100;
                osc.frequency.linearRampToValueAtTime(freq + randomOffset, ctx.currentTime + duration / 2);
                osc.frequency.linearRampToValueAtTime(freq, ctx.currentTime + duration);

                // Envelopes for jarring attack
                gain.gain.setValueAtTime(0, ctx.currentTime + startTime);
                gain.gain.linearRampToValueAtTime(1, ctx.currentTime + startTime + 0.1);
                gain.gain.setValueAtTime(1, ctx.currentTime + startTime + duration - 0.2);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + startTime + duration);

                osc.connect(gain);
                gain.connect(masterGain);
                
                osc.start(ctx.currentTime + startTime);
                osc.stop(ctx.currentTime + startTime + duration);
            };

            // Play the 4 discordant tones layered and slightly staggered
            const baseTime = 0;
            const totalDuration = 2.5;
            
            // Tone 1: High piercing alarm
            createDrone('square', 853, 0, totalDuration, baseTime);
            // Tone 2: Dissonant harmonic
            createDrone('sawtooth', 960, 50, totalDuration, baseTime + 0.1);
            // Tone 3: Low rumble/groan
            createDrone('sine', 150, -25, totalDuration, baseTime + 0.2);
            // Tone 4: Random unstable morphing tone
            createDrone('triangle', 450 + (Math.random() * 300), 10, totalDuration, baseTime + 0.3);

        } catch (e) {
            console.error("Web Audio API not supported or thwarted:", e);
        }
    };

    useEffect(() => {
        if (!audioRef.current) {
            audioRef.current = new Audio(alienAudio);
            audioRef.current.volume = 0.25;
        }

    }, []);

    useEffect(() => {
        if (history.length > 0) {
            localStorage.setItem('dipAnalyzerAlertHistory', JSON.stringify(history));
        }
    }, [history]);

    useEffect(() => {
        const handleAlert = (e) => {
            const { symbol, type, message, color = 'blue', timestamp = Date.now() } = e.detail;
            
            const newAlert = { id: timestamp + Math.random(), symbol, type, message, color, timestamp };

            // Prevent duplicate toasts
            setAlerts((prev) => {
                if (prev.find(a => a.symbol === symbol)) return prev;

                if (color === 'amber') {
                    // Play the new Web Audio amber alert
                    playAmberAlertSound();
                } else if (audioRef.current) {
                    // Play standard alien audio
                    audioRef.current.currentTime = 0;
                    audioRef.current.play().catch(err => console.log('Audio play prevented', err));
                }
                
                return [...prev, newAlert];
            });

            // Add to history
            setHistory(prev => [newAlert, ...prev]);
        };

        window.addEventListener('stock-alert', handleAlert);
        return () => window.removeEventListener('stock-alert', handleAlert);
    }, []);

    // Auto-dismiss toasts
    useEffect(() => {
        if (alerts.length > 0) {
            const timer = setTimeout(() => {
                setAlerts((prev) => prev.slice(1));
            }, 6000);
            return () => clearTimeout(timer);
        }
    }, [alerts]);

    return (
        <>
            {/* Live Toasts */}
            <div style={{
                position: 'fixed',
                bottom: '5rem', // Moved up slightly to make room for history button
                right: '2rem',
                zIndex: 9999,
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                pointerEvents: 'none'
            }}>
                {alerts.map((alert) => (
                    <div key={alert.id} style={{
                        background: alert.color === 'amber' 
                            ? 'linear-gradient(135deg, rgba(217, 119, 6, 0.8) 0%, rgba(180, 83, 9, 0.9) 100%)' 
                            : 'linear-gradient(135deg, rgba(30, 20, 60, 0.85) 0%, rgba(10, 20, 40, 0.9) 100%)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: alert.color === 'amber' ? '1px solid rgba(252, 211, 77, 0.7)' : '1px solid rgba(167, 139, 250, 0.3)',
                        borderRadius: '16px',
                        padding: '1.25rem 1.5rem',
                        boxShadow: alert.color === 'amber' ? '0 10px 30px rgba(217, 119, 6, 0.5), inset 0 1px 1px rgba(255,255,255,0.2)' : '0 10px 30px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.1)',
                        color: '#f8f9fc',
                        transformOrigin: 'bottom right',
                        animation: 'slide-in-alert 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
                        minWidth: '300px'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                            <span style={{ fontWeight: 'bold', fontSize: '1.1rem', letterSpacing: '0.05em', color: alert.color === 'amber' ? '#fffbeb' : '#fff' }}>
                                ${alert.symbol} {alert.type === 'breakout' || alert.type === 'bullish' ? '🚀' : '⚠️'}
                            </span>
                            <span style={{ 
                                fontSize: '0.75rem', 
                                padding: '0.15rem 0.5rem', 
                                borderRadius: '12px', 
                                background: alert.color === 'amber' ? 'rgba(255,255,255,0.25)' : (alert.type === 'breakout' || alert.type === 'bullish' ? 'rgba(52, 211, 153, 0.2)' : 'rgba(248, 113, 113, 0.2)'),
                                color: alert.color === 'amber' ? '#fde68a' : (alert.type === 'breakout' || alert.type === 'bullish' ? '#6ee7b7' : '#fca5a5'),
                                fontWeight: alert.color === 'amber' ? '900' : 'normal'
                            }}>
                                {alert.color === 'amber' ? 'AMBER ALERT' : (alert.type === 'breakout' ? 'TRENDING' : alert.type === 'bullish' ? 'BULLISH' : alert.type === 'bearish' ? 'BEARISH' : 'DOWNTREND')}
                            </span>
                        </div>
                        <div style={{ fontSize: '0.9rem', color: alert.color === 'amber' ? '#fef3c7' : '#e2e8f0', marginBottom: '0.5rem', fontWeight: alert.color === 'amber' ? 'bold' : 'normal' }}>
                            {alert.message}
                        </div>
                    </div>
                ))}
            </div>

            {/* History Toggle Button */}
            <div style={{
                position: 'fixed',
                bottom: '2rem',
                right: '2rem',
                zIndex: 9998,
            }}>
                <button 
                    onClick={() => setShowHistory(!showHistory)}
                    style={{
                        background: history.some(h => h.color === 'amber') ? '#d97706' : 'var(--primary)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '50%',
                        width: '3.5rem',
                        height: '3.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        boxShadow: history.some(h => h.color === 'amber') ? '0 4px 15px rgba(217, 119, 6, 0.5)' : '0 4px 12px rgba(0,0,0,0.3)',
                        transition: 'transform 0.2s',
                        position: 'relative'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                    title="Alert History"
                >
                    <History size={24} />
                    {history.length > 0 && (
                        <span style={{
                            position: 'absolute',
                            top: '-5px',
                            right: '-5px',
                            background: history.some(h => h.color === 'amber') ? '#b45309' : '#ef4444',
                            color: 'white',
                            fontSize: '0.7rem',
                            fontWeight: 'bold',
                            padding: '2px 6px',
                            borderRadius: '10px',
                            border: '1px solid rgba(255,255,255,0.2)'
                        }}>
                            {history.length}
                        </span>
                    )}
                </button>
            </div>

            {/* History Panel */}
            {showHistory && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: '350px',
                    background: 'rgba(15, 23, 42, 0.95)',
                    backdropFilter: 'blur(10px)',
                    borderLeft: '1px solid rgba(255,255,255,0.1)',
                    zIndex: 10000,
                    display: 'flex',
                    flexDirection: 'column',
                    animation: 'slide-in-right 0.3s ease-out forwards',
                    boxShadow: '-10px 0 25px rgba(0,0,0,0.5)'
                }}>
                    <div style={{
                        padding: '1.5rem',
                        borderBottom: '1px solid rgba(255,255,255,0.1)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                    }}>
                        <h2 style={{ margin: 0, fontSize: '1.25rem', color: 'white', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <History size={20} /> Alert History
                        </h2>
                        <button 
                            onClick={() => setShowHistory(false)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                        >
                            <X size={24} />
                        </button>
                    </div>
                    
                    <div style={{ padding: '1rem', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {history.length === 0 ? (
                            <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '2rem' }}>
                                No alerts recorded yet.
                            </div>
                        ) : (
                            history.map((alert) => (
                                <div key={alert.id} style={{
                                    padding: '1rem',
                                    borderRadius: '8px',
                                    background: alert.color === 'amber' ? 'rgba(217, 119, 6, 0.15)' : 'rgba(255,255,255,0.05)',
                                    border: alert.color === 'amber' ? '1px solid rgba(252, 211, 77, 0.4)' : '1px solid rgba(255,255,255,0.1)',
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                                        <span style={{ fontWeight: 'bold', color: alert.color === 'amber' ? '#fcd34d' : 'white' }}>
                                            ${alert.symbol} {alert.type === 'breakout' || alert.type === 'bullish' ? '🚀' : '⚠️'}
                                        </span>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                            {new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: '0.9rem', color: alert.color === 'amber' ? '#fef3c7' : 'var(--text-main)', lineHeight: '1.4' }}>
                                        {alert.message}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            <style>{`
                @keyframes slide-in-alert {
                    0% { opacity: 0; transform: translateY(20px) scale(0.95); }
                    100% { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes slide-in-right {
                    0% { transform: translateX(100%); }
                    100% { transform: translateX(0); }
                }
            `}</style>
        </>
    );
};

export default LiveAlerts;
