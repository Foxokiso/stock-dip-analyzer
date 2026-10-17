import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Palette, ScanSearch, ChartNoAxesCombined, Bell, Database, Archive, Info, RotateCcw, Copy, Check, Upload, ExternalLink, AlertTriangle } from 'lucide-react';
import { useSettings } from '../state/settingsContext.js';
import {
  APP_VERSION, DEFAULT_SETTINGS, DENSITIES, FUTURES_TIMEFRAME_IDS, GLOW_STEP, MOTIONS, RATING_FILTERS,
  REFRESH_MINUTES, SCAN_DEPTHS, SORTS, THEMES, isTransientTheme, parseSettingsImport, serializeSettings,
} from '../state/settingsSchema.js';
import { SECTORS } from '../data/sectors.js';
import { FUTURES_DELAY_MINUTES, FUTURES_GROUPS, FUTURES_TIMEFRAMES } from '../services/futures.js';
import '../styles/settings.css';

// Every control writes through useSettings().update('section.key', value);
// the sticky index on the left scrolls to, and tracks, the section on the right.

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, blurb: 'Theme, density, motion and glow for every desk.' },
  { id: 'scanner', label: 'Scanner', icon: ScanSearch, blurb: 'What the Overview, ETF and Discovery scans include, how deep they go and how often they re-run.' },
  { id: 'futures', label: 'Futures', icon: ChartNoAxesCombined, blurb: 'How the futures desk opens and what it discloses about its delayed Finviz feed.' },
  { id: 'alerts', label: 'Alerts', icon: Bell, blurb: 'Which technical alerts fire, how loud they are and how many are kept.' },
  { id: 'data', label: 'Data & sources', icon: Database, blurb: 'Read-only facts about caching, timeouts and provider delays.' },
  { id: 'backup', label: 'Backup', icon: Archive, blurb: 'Export, import or reset the whole settings document.' },
  { id: 'about', label: 'About', icon: Info, blurb: 'Version, the 27 system and where the design brief lives.' },
];

const RATING_LABELS = { All: 'All ratings', 'Sell/Strong Sell': 'Sell / Strong Sell' };
const BRIEF_PATH = 'docs/design/pierce27-brief.md';
const BRIEF_URL = `https://github.com/Foxokiso/stock-dip-analyzer/blob/v2/pierce27/${BRIEF_PATH}`;
const CHART_TIMEFRAMES = FUTURES_TIMEFRAMES.filter(item => FUTURES_TIMEFRAME_IDS.includes(item.id));

const trim = (value) => Number(value.toFixed(2)).toString();
const formatGlow = (value) => `${value.toFixed(2)} = ${trim(value / GLOW_STEP)}×${GLOW_STEP}`;
const formatPercent = (value) => `${Math.round(value * 100)}%`;
const formatMinutes = (value) => (value === 0 ? 'Off' : `${value} min`);
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── small building blocks ─────────────────────────────────────────────────

function Section({ id, title, blurb, onReset, children, headingRef }) {
  const headingId = `settings-${id}-title`;
  return (
    <section id={`settings-${id}`} className="settings-section glass-panel" aria-labelledby={headingId} data-section={id}>
      <header className="settings-section-head">
        <div>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>{title}</h2>
          <p>{blurb}</p>
        </div>
        {onReset && (
          <button type="button" className="settings-reset" onClick={onReset} aria-label={`Reset ${title} to defaults`}>
            <RotateCcw size={13} aria-hidden="true" />Reset
          </button>
        )}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, htmlFor, labelId, children, wide }) {
  return (
    <div className={`settings-field${wide ? ' is-wide' : ''}`} role={labelId && !htmlFor ? 'group' : undefined} aria-labelledby={labelId && !htmlFor ? labelId : undefined}>
      <div className="settings-field-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span id={labelId}>{label}</span>}
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

// Native radios inside labels: arrow keys move between options, the ring shows on the label.
function Segmented({ name, value, options, onChange, labelledBy }) {
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map(option => (
        <label key={String(option.id)} className={`segmented-option${option.id === value ? ' is-active' : ''}`} title={option.blurb}>
          <input type="radio" name={name} value={String(option.id)} checked={option.id === value} onChange={() => onChange(option.id)} className="visually-hidden" />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function Switch({ id, checked, onChange, children }) {
  return (
    <label className="switch" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} aria-checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span className="switch-text">{children}</span>
    </label>
  );
}

function Slider({ id, value, min = 0, max = 1, step = 0.01, onChange, format, describedBy }) {
  const outputId = `${id}-value`;
  return (
    <div className="slider">
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-describedby={describedBy} aria-valuetext={format(value)} style={{ '--fill': `${((value - min) / (max - min)) * 100}%` }} />
      <output id={outputId} htmlFor={id} className="slider-value">{format(value)}</output>
    </div>
  );
}

function Select({ id, value, options, onChange }) {
  return (
    <select id={id} value={String(value)} onChange={(e) => onChange(options.find(option => String(option.id) === e.target.value)?.id ?? value)}>
      {options.map(option => <option key={String(option.id)} value={String(option.id)}>{option.label}</option>)}
    </select>
  );
}

function Checkbox({ id, checked, onChange, children, tone }) {
  return (
    <label className={`checkbox${checked ? ' is-checked' : ''}${tone ? ` tone-${tone}` : ''}`} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
      <span>{children}</span>
    </label>
  );
}

function ThemeCard({ theme, selected, onSelect, name }) {
  const transient = isTransientTheme(theme.id);
  return (
    <label className={`theme-card${selected ? ' is-selected' : ''}`} title={theme.blurb}>
      <input type="radio" name={name} value={theme.id} checked={selected} onChange={() => onSelect(theme.id)} className="visually-hidden" />
      {/* The theme class scopes that theme's tokens to the swatch, so each
          strip shows the real primary/complement pair of the theme it names. */}
      <span className={`theme-swatch ${theme.id}`} aria-hidden="true">
        <span className="theme-swatch-ink" />
        <span className="theme-swatch-a" />
        <span className="theme-swatch-b" />
      </span>
      <span className="theme-card-text">
        <strong>{theme.label}</strong>
        <small>{theme.blurb}</small>
        {transient && <em>Not saved</em>}
      </span>
    </label>
  );
}

// ── the desk ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { settings, update, reset, replace } = useSettings();
  const uid = useId();
  const [active, setActive] = useState(SECTIONS[0].id);
  const headingRefs = useRef({});
  const deskRef = useRef(null);

  // Track which section is in view for the index.
  useEffect(() => {
    const root = deskRef.current;
    if (!root || typeof IntersectionObserver !== 'function') return undefined;
    const sections = Array.from(root.querySelectorAll('[data-section]'));
    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.dataset.section, entry.boundingClientRect.top);
        else visible.delete(entry.target.dataset.section);
      }
      if (visible.size === 0) return;
      const [topmost] = [...visible.entries()].sort((a, b) => a[1] - b[1]);
      setActive(topmost[0]);
    }, { rootMargin: '-27% 0px -54% 0px', threshold: [0, 0.27, 0.54, 1] });
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const jumpTo = useCallback((id) => {
    const section = document.getElementById(`settings-${id}`);
    if (!section) return;
    const motion = settings.appearance.motion;
    const smooth = motion === 'full' || (motion === 'system' && !prefersReducedMotion());
    section.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    headingRefs.current[id]?.focus({ preventScroll: true });
    setActive(id);
  }, [settings.appearance.motion]);

  const bindHeading = (id) => (node) => { headingRefs.current[id] = node; };

  const { appearance, scanner, futures, alerts, data } = settings;

  // ── backup state ──
  const exported = useMemo(() => serializeSettings(settings), [settings]);
  const exportRef = useRef(null);
  const [copyState, setCopyState] = useState(null); // 'copied' | 'manual'
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState(null);
  const [importNote, setImportNote] = useState(null);
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    if (!copyState) return undefined;
    const timer = setTimeout(() => setCopyState(null), 2700);
    return () => clearTimeout(timer);
  }, [copyState]);
  useEffect(() => {
    if (!resetArmed) return undefined;
    const timer = setTimeout(() => setResetArmed(false), 5400);
    return () => clearTimeout(timer);
  }, [resetArmed]);

  const copyExport = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(exported);
      setCopyState('copied');
    } catch {
      exportRef.current?.focus();
      exportRef.current?.select();
      setCopyState('manual');
    }
  };

  const applyImport = () => {
    setImportNote(null);
    try {
      const next = parseSettingsImport(importText);
      replace(next);
      setImportError(null);
      setImportNote('Settings applied. Preferences replaced the current document; source facts use the current app defaults. Unknown keys were ignored.');
    } catch (error) {
      setImportError(error.message);
    }
  };

  const resetAll = () => {
    if (!resetArmed) { setResetArmed(true); return; }
    reset();
    setResetArmed(false);
    setImportText('');
    setImportError(null);
    setImportNote('Every section is back to its defaults.');
  };

  const toggleSector = (id, checked) => update('scanner.excludedSectors', (current) => (
    checked ? [...new Set([...current, id])] : current.filter(item => item !== id)
  ));

  const ids = {
    theme: `${uid}-theme`, density: `${uid}-density`, motion: `${uid}-motion`, glow: `${uid}-glow`,
    sectors: `${uid}-sectors`, refresh: `${uid}-refresh`, depth: `${uid}-depth`, rating: `${uid}-rating`, sort: `${uid}-sort`,
    group: `${uid}-group`, timeframe: `${uid}-timeframe`, delay: `${uid}-delay`,
    sound: `${uid}-sound`, volume: `${uid}-volume`, types: `${uid}-types`, minScore: `${uid}-min-score`, history: `${uid}-history`,
    exportBox: `${uid}-export`, importBox: `${uid}-import`,
  };

  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" aria-hidden="true" />WORKSPACE / PREFERENCES</div>
          <h2>Settings</h2>
          <p className="text-muted">Everything here is saved as one document the moment it changes. Each section says what it affects and can be reset on its own.</p>
        </div>
      </div>

      <div className="settings-desk" ref={deskRef}>
        <nav className="settings-index" aria-label="Settings sections">
          <ol>
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const { id, label } = section;
              return (
                <li key={id}>
                  <button type="button" onClick={() => jumpTo(id)} aria-current={active === id ? 'true' : undefined} className={active === id ? 'is-active' : undefined}>
                    <Icon size={14} aria-hidden="true" />{label}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="settings-index-note">Settings version {DEFAULT_SETTINGS.version} · app {APP_VERSION}</p>
        </nav>

        <div className="settings-content">
          {/* 1 ── Appearance */}
          <Section id="appearance" title="Appearance" blurb={SECTIONS[0].blurb} onReset={() => reset('appearance')} headingRef={bindHeading('appearance')}>
            <Field label="Theme" hint="Selected on every desk immediately. Seizure Mode runs for 20 seconds and is never saved." labelId={ids.theme} wide>
              <div className="theme-grid" role="radiogroup" aria-labelledby={ids.theme}>
                {THEMES.map(theme => (
                  <ThemeCard key={theme.id} theme={theme} name={`${uid}-theme-choice`} selected={appearance.theme === theme.id} onSelect={(id) => update('appearance.theme', id)} />
                ))}
              </div>
            </Field>
            <Field label="Density" hint="Compact tightens every gap and table row by 27 %." labelId={ids.density}>
              <Segmented name={`${uid}-density-choice`} value={appearance.density} options={DENSITIES} onChange={(id) => update('appearance.density', id)} labelledBy={ids.density} />
            </Field>
            <Field label="Motion" hint="System follows the OS preference; Reduced removes transitions and pulses; Full animates regardless." labelId={ids.motion}>
              <Segmented name={`${uid}-motion-choice`} value={appearance.motion} options={MOTIONS} onChange={(id) => update('appearance.motion', id)} labelledBy={ids.motion} />
            </Field>
            <Field label="Glow intensity" hint={`Scales every halo (buttons, live dots, selected cards). The default is 2×${GLOW_STEP}.`} htmlFor={ids.glow}>
              <Slider id={ids.glow} value={appearance.glow} min={0} max={1} step={0.01} onChange={(value) => update('appearance.glow', value)} format={formatGlow} />
            </Field>
          </Section>

          {/* 2 ── Scanner */}
          <Section id="scanner" title="Scanner" blurb={SECTIONS[1].blurb} onReset={() => reset('scanner')} headingRef={bindHeading('scanner')}>
            <Field label="Excluded sectors" hint="Checked sectors are left out of broad “any sector” scans on the Overview, ETF rankings and Discovery desks." labelId={ids.sectors} wide>
              <div className="checkbox-grid" role="group" aria-labelledby={ids.sectors}>
                {SECTORS.map(sector => (
                  <Checkbox key={sector.id} id={`${uid}-sector-${sector.id}`} checked={scanner.excludedSectors.includes(sector.id)} onChange={(checked) => toggleSector(sector.id, checked)} tone="danger">
                    {sector.label}
                  </Checkbox>
                ))}
              </div>
            </Field>
            <Field label="Refresh interval" hint="How often every desk re-runs its scan. Off means manual refresh only." labelId={ids.refresh}>
              <Segmented name={`${uid}-refresh-choice`} value={scanner.refreshMinutes} options={REFRESH_MINUTES.map(value => ({ id: value, label: formatMinutes(value) }))} onChange={(value) => update('scanner.refreshMinutes', value)} labelledBy={ids.refresh} />
            </Field>
            <Field label="Scan depth" hint="Names fetched from the Finviz screener per scan. Each one needs its own Yahoo chart request, so deeper scans take proportionally longer and hold more rows in memory." labelId={ids.depth}>
              <Segmented name={`${uid}-depth-choice`} value={scanner.scanDepth} options={SCAN_DEPTHS.map(value => ({ id: value, label: `Top ${value}` }))} onChange={(value) => update('scanner.scanDepth', value)} labelledBy={ids.depth} />
            </Field>
            <Field label="Default rating filter" hint="What the header rating filter starts on when the app opens." htmlFor={ids.rating}>
              <Select id={ids.rating} value={scanner.defaultRating} options={RATING_FILTERS.map(id => ({ id, label: RATING_LABELS[id] ?? id }))} onChange={(id) => update('scanner.defaultRating', id)} />
            </Field>
            <Field label="Default sort" hint="Initial order of the Overview table. Clicking a column header still overrides it for the session." htmlFor={ids.sort}>
              <Select id={ids.sort} value={scanner.sort} options={SORTS} onChange={(id) => update('scanner.sort', id)} />
            </Field>
          </Section>

          {/* 3 ── Futures */}
          <Section id="futures" title="Futures" blurb={SECTIONS[2].blurb} onReset={() => reset('futures')} headingRef={bindHeading('futures')}>
            <Field label="Default market group" hint="The category the board opens on." htmlFor={ids.group}>
              <Select id={ids.group} value={futures.defaultGroup} options={[{ id: 'all', label: 'All markets' }, ...FUTURES_GROUPS.map(group => ({ id: group.id, label: group.label }))]} onChange={(id) => update('futures.defaultGroup', id)} />
            </Field>
            <Field label="Default timeframe" hint="Sparkline and focus-chart interval requested from Finviz." labelId={ids.timeframe}>
              <Segmented name={`${uid}-timeframe-choice`} value={futures.timeframe} options={CHART_TIMEFRAMES} onChange={(id) => update('futures.timeframe', id)} labelledBy={ids.timeframe} />
            </Field>
            <Field label="Delay notice" hint="Shows the delayed-data banner above the board." labelId={ids.delay}>
              <Switch id={`${uid}-delay-switch`} checked={futures.showDelayNotice} onChange={(checked) => update('futures.showDelayNotice', checked)}>Show the delay notice on the futures desk</Switch>
            </Field>
            <div className="settings-disclosure" role="note">
              <AlertTriangle size={14} aria-hidden="true" />
              <p>Finviz futures quotes are delayed {FUTURES_DELAY_MINUTES} minutes and the feed carries no quote timestamps. The desk therefore shows when it retrieved the data and the published delay; it never shows, or invents, a source quote time.</p>
            </div>
          </Section>

          {/* 4 ── Alerts */}
          <Section id="alerts" title="Alerts" blurb={SECTIONS[3].blurb} onReset={() => reset('alerts')} headingRef={bindHeading('alerts')}>
            <Field label="Sound" hint="Plays a short tone when an alert arrives." labelId={ids.sound}>
              <Switch id={`${uid}-sound-switch`} checked={alerts.sound} onChange={(checked) => update('alerts.sound', checked)}>Alert sound {alerts.sound ? 'on' : 'off'}</Switch>
            </Field>
            <Field label="Volume" hint="Relative loudness of the alert tone." htmlFor={ids.volume}>
              <Slider id={ids.volume} value={alerts.volume} min={0} max={1} step={0.01} onChange={(value) => update('alerts.volume', value)} format={formatPercent} />
            </Field>
            <Field label="Alert types" hint="Which technical events raise an alert." labelId={ids.types}>
              <div className="checkbox-row" role="group" aria-labelledby={ids.types}>
                <Checkbox id={`${uid}-type-breakout`} checked={alerts.breakout} onChange={(checked) => update('alerts.breakout', checked)} tone="success">Breakout</Checkbox>
                <Checkbox id={`${uid}-type-breakdown`} checked={alerts.breakdown} onChange={(checked) => update('alerts.breakdown', checked)} tone="danger">Breakdown</Checkbox>
                <Checkbox id={`${uid}-type-trend`} checked={alerts.trend} onChange={(checked) => update('alerts.trend', checked)} tone="info">Trend</Checkbox>
              </div>
            </Field>
            <Field label="Minimum score" hint="Only names scoring at or above this raise an alert (0–100)." htmlFor={ids.minScore}>
              <div className="number-with-range">
                <input type="range" min={0} max={100} step={1} value={alerts.minScore} aria-label="Minimum score slider" onChange={(e) => update('alerts.minScore', Number(e.target.value))} style={{ '--fill': `${alerts.minScore}%` }} />
                <input id={ids.minScore} type="number" min={0} max={100} step={1} inputMode="numeric" value={alerts.minScore} onChange={(e) => update('alerts.minScore', clampInt(e.target.value, 0, 100, DEFAULT_SETTINGS.alerts.minScore))} />
              </div>
            </Field>
            <Field label="History limit" hint="How many past alerts the history drawer keeps (1–1000)." htmlFor={ids.history}>
              <input id={ids.history} className="settings-number" type="number" min={1} max={1000} step={1} inputMode="numeric" value={alerts.historyLimit} onChange={(e) => update('alerts.historyLimit', clampInt(e.target.value, 1, 1000, DEFAULT_SETTINGS.alerts.historyLimit))} />
            </Field>
          </Section>

          {/* 5 ── Data & sources */}
          <Section id="data" title="Data & sources" blurb={SECTIONS[4].blurb} headingRef={bindHeading('data')}>
            <dl className="settings-facts">
              <div><dt>Chart cache</dt><dd>{data.chartCacheSeconds === 0 ? 'Disabled' : `${data.chartCacheSeconds} s`}</dd></div>
              <div><dt>Request timeout</dt><dd>{data.requestTimeoutSeconds} s</dd></div>
              <div><dt>Finviz screener delay</dt><dd>1 min</dd></div>
              <div><dt>Finviz futures delay</dt><dd>{FUTURES_DELAY_MINUTES} min</dd></div>
              <div><dt>Yahoo Finance delay</dt><dd>As reported by the provider with each quote</dd></div>
            </dl>
            <p className="settings-footnote">Retrieval time (when this app fetched the data) and source quote time (when the provider says the quote was struck) are always shown separately, and neither is ever estimated. Unavailable data is shown as unavailable.</p>
          </Section>

          {/* 6 ── Backup */}
          <Section id="backup" title="Backup" blurb={SECTIONS[5].blurb} headingRef={bindHeading('backup')}>
            <Field label="Export" hint="The current document as JSON. Seizure Mode is written as the default theme." htmlFor={ids.exportBox} wide>
              <textarea id={ids.exportBox} ref={exportRef} className="settings-json" readOnly value={exported} rows={10} spellCheck={false} />
              <div className="settings-actions">
                <button type="button" className="btn btn-outline" onClick={copyExport}>
                  {copyState === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  {copyState === 'copied' ? 'Copied' : 'Copy'}
                </button>
                <span className="settings-status" role="status" aria-live="polite">
                  {copyState === 'copied' && 'Copied to the clipboard.'}
                  {copyState === 'manual' && 'Clipboard unavailable — the text is selected; copy it manually.'}
                </span>
              </div>
            </Field>
            <Field label="Import" hint="Paste a document exported from this app. Invalid values are reported, not guessed." htmlFor={ids.importBox} wide>
              <textarea id={ids.importBox} className="settings-json" value={importText} onChange={(e) => { setImportText(e.target.value); setImportError(null); setImportNote(null); }} rows={8} spellCheck={false} placeholder='{ "appearance": { "theme": "theme-majestic" } }' aria-describedby={importError ? `${ids.importBox}-error` : undefined} aria-invalid={importError ? 'true' : undefined} />
              <div className="settings-actions">
                <button type="button" className="btn btn-primary" onClick={applyImport} disabled={!importText.trim()}><Upload size={14} aria-hidden="true" />Apply</button>
                {importError && <span id={`${ids.importBox}-error`} className="settings-error" role="alert"><AlertTriangle size={13} aria-hidden="true" />{importError}</span>}
                {importNote && !importError && <span className="settings-status" role="status">{importNote}</span>}
              </div>
            </Field>
            <Field label="Reset all" hint="Puts every section back to its defaults. Nothing else is touched." wide>
              <div className="settings-actions">
                <button type="button" className={`btn ${resetArmed ? 'btn-primary is-danger' : 'btn-outline'}`} onClick={resetAll} aria-live="polite">
                  <RotateCcw size={14} aria-hidden="true" />{resetArmed ? 'Click again to confirm' : 'Reset all settings'}
                </button>
                {resetArmed && <span className="settings-status" role="status">Confirms for a few seconds, then disarms.</span>}
              </div>
            </Field>
          </Section>

          {/* 7 ── About */}
          <Section id="about" title="About" blurb={SECTIONS[6].blurb} headingRef={bindHeading('about')}>
            <div className="settings-about">
              <p className="settings-about-title"><strong>Dip Analyzer PRO</strong> <span className="settings-version">v{APP_VERSION}</span></p>
              <p>The interface is built on the 27 system: every hue sits on a grid of 27° steps in OKLCH, so hue k and hue k + 20 are exact complements and each pierce pair (magenta/green, cyan/red, violet/yellow, amber/blue) cuts through the ink instead of blending into it. Tints, washes and timing are the same base multiplied by 0.73, 0.46 and 0.27 — nothing is picked by eye.</p>
              <p>
                The design contract is <code>{BRIEF_PATH}</code> in the repository.{' '}
                <a href={BRIEF_URL} target="_blank" rel="noopener noreferrer">Open the brief <ExternalLink size={12} aria-hidden="true" /></a>
              </p>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
