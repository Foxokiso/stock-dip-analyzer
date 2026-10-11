import * as cheerio from 'cheerio';
import fs from 'fs';

async function scrapeFinviz() {
    const html = fs.readFileSync('finviz_output.html', 'utf8');
    const $ = cheerio.load(html);

    const stocks = [];

    // Use rows instead of links to get structured data robustly
    $('tr').each((i, row) => {
        const cells = $(row).children('td');

        // v=111 Overview columns usually have No, Ticker, Company, Sector, Industry, Country, MCap, PE, Price, Change, Volume
        if (cells.length === 11) {
            const numberText = $(cells[0]).text().trim();
            const tickerLink = $(cells[1]).find('a[href^="quote.ashx"]');

            // Check if this row is actually a data row (has a number and a ticker link)
            if (parseInt(numberText) > 0 && tickerLink.length > 0) {
                const ticker = tickerLink.text().trim();

                if (ticker && !stocks.find(s => s.symbol === ticker)) {
                    const changeStr = $(cells[9]).text().trim();
                    const parsedChange = parseFloat(changeStr.replace('%', ''));
                    const change = Number.isFinite(parsedChange) ? parsedChange : null;
                    const parsedPrice = parseFloat($(cells[8]).text().trim());

                    stocks.push({
                        symbol: ticker,
                        name: $(cells[2]).text().trim(),
                        price: Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : null,
                        changePercentage: change,
                        // This is a captured daily change, not a historical dip analysis.
                        dipPercentage: null,
                        recoveryProbability: null // No score without validated historical analysis
                    });
                }
            }
        }
    });

    console.log('Captured fixture rows:', stocks.length, 'stocks');
    console.log(JSON.stringify(stocks.slice(0, 5), null, 2));
}

scrapeFinviz();
