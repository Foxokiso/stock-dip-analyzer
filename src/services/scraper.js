import * as cheerio from 'cheerio';
import fs from 'fs';

async function scrapeFinviz() {
    const html = fs.readFileSync('finviz_output.html', 'utf8');
    const $ = cheerio.load(html);

    const stocks = [];

    // Use rows instead of links to get structured data robustly
    $('tr').each((i, row) => {
        const cells = $(row).find('td');

        // v=111 Overview columns usually have No, Ticker, Company, Sector, Industry, Country, MCap, PE, Price, Change, Volume
        if (cells.length >= 10) {
            const numberText = $(cells[0]).text().trim();
            const tickerLink = $(cells[1]).find('a[href^="quote.ashx"]');

            // Check if this row is actually a data row (has a number and a ticker link)
            if (parseInt(numberText) > 0 && tickerLink.length > 0) {
                const ticker = tickerLink.text().trim();

                if (ticker && !stocks.find(s => s.symbol === ticker)) {
                    const changeStr = $(cells[9]).text().trim();
                    const change = parseFloat(changeStr.replace('%', '')) || 0;

                    stocks.push({
                        symbol: ticker,
                        name: $(cells[2]).text().trim(),
                        price: parseFloat($(cells[8]).text().trim()) || 0,
                        changePercentage: change,
                        dipPercentage: change < 0 ? Math.abs(change) : 0, // Mock dip calculated from today's change for now
                        recoveryProbability: Math.floor(Math.random() * (95 - 45 + 1)) + 45 // Random for now until AI integration
                    });
                }
            }
        }
    });

    console.log('Found', stocks.length, 'stocks');
    console.log(JSON.stringify(stocks.slice(0, 5), null, 2));
}

scrapeFinviz();
