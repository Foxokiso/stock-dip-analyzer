// Where an options chain is busiest: contracts whose volume today is above their open
// interest. This is arithmetic on two numbers Finviz prints for each contract. It says
// nothing about who traded or how (buys, sells, sweeps): Finviz's chain has no
// trade-by-trade data. An unknown value is never counted as activity.

/** Fewer contracts than this is too thin to call unusual, whatever the open interest. */
export const UNUSUAL_MIN_VOLUME = 100;
const CONTRACT_SIZE = 100;

const known = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * @param {{ volume: number|null, openInterest: number|null, mid: number|null, last: number|null }} item
 * @returns {{ volume: number|null, openInterest: number|null, ratio: number|null,
 *   premium: number|null, premiumBasis: 'mid'|'last'|null, unusual: boolean }}
 *   `ratio` is volume over open interest (Infinity when volume trades against none);
 *   `premium` is the dollars changing hands at the midpoint, else at the last trade.
 */
export function contractActivity(item) {
    const volume = known(item?.volume) ? item.volume : null;
    const openInterest = known(item?.openInterest) ? item.openInterest : null;
    let ratio = null;
    if (volume !== null && openInterest !== null) {
        if (openInterest > 0) ratio = volume / openInterest;
        else if (volume > 0) ratio = Infinity;
    }
    let price = null;
    let premiumBasis = null;
    if (known(item?.mid)) { price = item.mid; premiumBasis = 'mid'; }
    else if (known(item?.last)) { price = item.last; premiumBasis = 'last'; }
    const premium = volume !== null && price !== null ? Math.round(volume * price * CONTRACT_SIZE) : null;
    const unusual = volume !== null && openInterest !== null && volume >= UNUSUAL_MIN_VOLUME && volume > openInterest;
    return { volume, openInterest, ratio, premium, premiumBasis, unusual };
}

/**
 * The unusual contracts of a parsed chain, largest premium first (contracts without a
 * premium after those with one, by ratio), at most `limit` of them.
 * @returns {Array<{ contract: object } & ReturnType<typeof contractActivity>>}
 */
export function unusualContracts(chain, limit = 8) {
    const found = [];
    for (const row of chain?.strikes ?? []) {
        for (const contract of [row.call, row.put]) {
            if (!contract) continue;
            const activity = contractActivity(contract);
            if (activity.unusual) found.push({ contract, ...activity });
        }
    }
    found.sort((a, b) => {
        if ((a.premium === null) !== (b.premium === null)) return a.premium === null ? 1 : -1;
        if (a.premium !== b.premium) return b.premium - a.premium;
        return b.ratio - a.ratio || 0;
    });
    return found.slice(0, limit);
}
