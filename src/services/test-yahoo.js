async function testYahooFinanceFetch(symbol) {
    // Yahoo Finance Chart API for past 1 month, 1 day intervals
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
            console.error('Fetch failed with status:', response.status);
            return;
        }

        const json = await response.json();
        const result = json.chart.result[0];

        const timestamps = result.timestamp;
        const closes = result.indicators.quote[0].close;

        const chartData = timestamps.map((ts, index) => {
            const date = new Date(ts * 1000);
            return {
                date: `${date.getMonth() + 1}/${date.getDate()}`,
                price: closes[index]
            };
        }).filter(d => d.price !== null);

        console.log(`Successfully fetched ${chartData.length} data points for ${symbol}`);
        console.log(JSON.stringify(chartData.slice(-5), null, 2));

    } catch (err) {
        console.error('Error fetching Yahoo Finance:', err);
    }
}

testYahooFinanceFetch('TSM');
