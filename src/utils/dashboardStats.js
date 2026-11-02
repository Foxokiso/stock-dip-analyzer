export function summarizeStocks(stocks) {
    let changeTotal = 0;
    let knownChanges = 0;
    let buySignals = 0;
    let lowScoreCount = 0;
    let scoredCount = 0;
    let deepestDip = null;

    for (const stock of stocks) {
        const change = stock.changePercentage;
        if (Number.isFinite(change)) {
            changeTotal += change;
            knownChanges++;
        }
        if ((stock.recoveryProbability ?? 0) >= 60) buySignals++;
        if (stock.isZombie) lowScoreCount++;
        if (stock.analysis) scoredCount++;
        if (change < 0 && (deepestDip === null || change < deepestDip.changePercentage)) deepestDip = stock;
    }

    return {
        scanned: stocks.length,
        avgDayChange: knownChanges > 0 ? changeTotal / knownChanges : null,
        buySignals,
        lowScoreCount,
        scoredCount,
        deepestDip,
    };
}
