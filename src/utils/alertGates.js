// Which technical alerts Settings → Alerts lets through. Pure: no DOM, no React.
// LiveAlerts applies it to every 'stock-alert' event; an alert it drops never
// renders, sounds or reaches the history. tests/alertGates.test.js covers it.

// Which Settings → Alerts switch governs each alert type. Any other type is dropped.
const SETTING_FOR_TYPE = { breakout: 'breakout', breakdown: 'breakdown', bullish: 'trend', bearish: 'trend' };
// The minimum score is a dip-entry threshold, so it gates Bullish alerts only. A
// breakout is a fresh one-month closing high, which the dip score keeps at or under
// 50 in practice (no dip, no bounce to score), and breakdown and bearish warnings
// come from low-scoring setups: those are raised whatever the score.
const SCORE_GATED_TYPES = new Set(['bullish']);

/** Whether the alert settings show an alert of `type`; `score` is null when the emitter attached none. */
export const allows = (prefs, type, score) => {
    // Type gate: only breakout / breakdown / trend alerts the user has enabled.
    const gate = SETTING_FOR_TYPE[type];
    if (!gate || !prefs[gate]) return false;
    // Score gate, Bullish only, where the emitter attached a score.
    return !(SCORE_GATED_TYPES.has(type) && score !== null && score < prefs.minScore);
};

/**
 * The condition of a 'stock-alert' event the alert settings show, or null. A
 * scan's alert lists every condition that turned true together, in precedence
 * order, and the first one allowed is shown, so a type switched off never hides
 * the next; other alerts name one condition. The alert's score applies to each.
 */
export const shownCondition = (prefs, detail) => {
    const score = Number.isFinite(detail.score) ? detail.score : null;
    return (Array.isArray(detail.conditions) ? detail.conditions : [detail])
        .find(condition => condition && allows(prefs, condition.type, score)) ?? null;
};
