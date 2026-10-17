import { useSettings } from '../state/settingsContext.js';
import { SECTORS } from '../data/sectors.js';

// Placeholder: the full Settings desk replaces this file. It keeps the two
// legacy controls working against the v2 settings store in the meantime.
export default function SettingsPage() {
  const { settings, update } = useSettings();
  const excluded = settings.scanner.excludedSectors;
  const toggleSector = (id) => update('scanner.excludedSectors', excluded.includes(id) ? excluded.filter(s => s !== id) : [...excluded, id]);

  return (
    <div className="settings" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2>Scanner Settings</h2>
      <p className="text-muted" style={{ marginBottom: '2rem' }}>Configure your stock screener preferences and ignored sectors.</p>
      <div className="glass-panel" style={{ padding: '2rem' }}>
        <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Omitted Sectors</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          {SECTORS.map(sector => (
            <label key={sector.id} className="flex-center" style={{ justifyContent: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={excluded.includes(sector.id)} onChange={() => toggleSector(sector.id)} />
              <span style={{ color: excluded.includes(sector.id) ? 'var(--danger)' : 'var(--text-main)' }}>{sector.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="glass-panel" style={{ padding: '2rem', marginTop: '2rem' }}>
        <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Auto-Refresh Interval</h3>
        <select value={settings.scanner.refreshMinutes} onChange={(e) => update('scanner.refreshMinutes', Number(e.target.value))}>
          <option value={0}>Off (Manual Only)</option>
          <option value={1}>Every 1 Minute</option>
          <option value={15}>Every 15 Minutes</option>
          <option value={30}>Every 30 Minutes</option>
        </select>
      </div>
    </div>
  );
}
