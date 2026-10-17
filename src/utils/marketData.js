// Normalize provider values once so every surface preserves missing data and quote times.
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const isoTime = (seconds) => positive(seconds) && Number.isFinite(new Date(seconds * 1000).getTime())
    ? new Date(seconds * 1000).toISOString() : null;

const exchangeDay = (seconds, timezone) => {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
    } catch {
        return new Date(seconds * 1000).toISOString().slice(0, 10);
    }
};

export function getYahooChartPoints(result) {
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const timezone = result?.meta?.exchangeTimezoneName;
    return timestamps.flatMap((timestamp, index) => {
        const price = positive(closes[index]);
        return positive(timestamp) && isoTime(timestamp) && price !== null
            ? [{ timestamp, date: exchangeDay(timestamp, timezone), price }] : [];
    }).sort((a, b) => a.timestamp - b.timestamp);
}

export function getYahooQuote(result, { fetchedAt = new Date().toISOString(), range } = {}) {
    const meta = result?.meta || {};
    const points = getYahooChartPoints(result);
    const price = positive(meta.regularMarketPrice);
    const quotedAt = isoTime(meta.regularMarketTime);
    let previousClose = positive(meta.previousClose);
    // chartPreviousClose is a range-start reference: it is yesterday only on a one-day request.
    if (previousClose === null && (range || meta.range) === '1d') previousClose = positive(meta.chartPreviousClose);
    if (previousClose === null && quotedAt) {
        const quoteDay = exchangeDay(meta.regularMarketTime, meta.exchangeTimezoneName);
        const timestamps = result?.timestamp || [];
        const closes = result?.indicators?.quote?.[0]?.close || [];
        // Preserve null bars when locating the prior session: skipping a missing
        // session would turn a multi-session return into a misleading day change.
        const previousIndex = timestamps.findLastIndex(timestamp => positive(timestamp) && isoTime(timestamp)
            && timestamp < meta.regularMarketTime && exchangeDay(timestamp, meta.exchangeTimezoneName) < quoteDay);
        previousClose = previousIndex >= 0 ? positive(closes[previousIndex]) : null;
    }
    const delay = finite(meta.exchangeDataDelayedBy);
    return {
        price,
        previousClose,
        changePct: price !== null && previousClose !== null ? ((price - previousClose) / previousClose) * 100 : null,
        closes: points.map(point => point.price),
        quotedAt,
        fetchedAt,
        source: 'Yahoo Finance',
        delayMinutes: delay !== null && delay >= 0 ? delay : null,
        currency: typeof meta.currency === 'string' ? meta.currency : null,
        exchangeTimezone: typeof meta.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : null,
    };
}

export function canRaiseTechnicalAlert(quote, historyLength, now = Date.now()) {
    const quoteTime = Date.parse(quote?.quotedAt);
    const age = now - quoteTime;
    return positive(quote?.price) !== null && historyLength >= 15 && quote?.delayMinutes === 0
        && Number.isFinite(quoteTime) && age >= 0 && age <= 5 * 60 * 1000;
}
