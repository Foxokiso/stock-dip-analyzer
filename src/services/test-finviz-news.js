import * as cheerio from 'cheerio';

async function testFinvizNews(symbol) {
    const url = `https://finviz.com/quote.ashx?t=${symbol}&p=d`;

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }
        });

        if (!response.ok) {
            console.error('Fetch failed with status:', response.status);
            return;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const news = [];
        // The news table in Finviz usually has id 'news-table'
        $('#news-table tr').each((i, row) => {
            if (i > 5) return; // limit to top 5 news

            const timeCell = $(row).find('td').first();
            const linkCell = $(row).find('a').first();

            let time = timeCell.text().trim();
            const title = linkCell.text().trim();
            const link = linkCell.attr('href');

            if (title && link) {
                news.push({ time, title, link });
            }
        });

        console.log(`Successfully fetched ${news.length} news items for ${symbol}`);
        console.log(JSON.stringify(news, null, 2));

    } catch (err) {
        console.error('Error fetching Finviz news:', err);
    }
}

testFinvizNews('TSM');
