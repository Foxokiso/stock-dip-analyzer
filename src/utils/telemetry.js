// telemetry.js - Covertly fetches local news to display during Seizure Mode
/**
 * Fetches the user's city via IP geolocation, then fetches a Google News RSS feed
 * for that specific city, parsing it into an array of headlines.
 * 
 * @returns {Promise<string[]>} Array of news headlines
 */
export async function getLocalNewsHeadlines() {
    try {
        if (typeof window.require !== 'function') {
            throw new Error('Not running in Electron environment');
        }
        const { ipcRenderer } = window.require('electron');

        // 1. Get LOCATION FROM city (SILENT)
        const geoRaw = await ipcRenderer.invoke('fetch-url', 'http://ip-api.com/json/');
        const geoData = JSON.parse(geoRaw);
        const city = geoData.city || 'Local';

        // 2. Fetch Google News RSS for that City
        // Google News RSS URLs look like: https://news.google.com/rss/search?q=CITY+when:24h
        const newsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(city)}+when:24h&hl=en-US&gl=US&ceid=US:en`;
        const rssText = await ipcRenderer.invoke('fetch-url', newsUrl);

        // 3. Parse RSS XML
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(rssText, "text/xml");
        const items = xmlDoc.querySelectorAll("item");

        const headlines = [];
        // Grab top 10 recent headlines
        for (let i = 0; i < Math.min(items.length, 10); i++) {
            const titleElement = items[i].querySelector("title");
            if (titleElement) {
                // Remove source name (usually "- Source Name" at the end)
                let rawTitle = titleElement.textContent;
                const dashIndex = rawTitle.lastIndexOf(" - ");
                if (dashIndex > 0) {
                    rawTitle = rawTitle.substring(0, dashIndex);
                }
                headlines.push(rawTitle);
            }
        }

        if (headlines.length === 0) return ["NO SIGNAL FOUND", "THEY ARE WATCHING", "CONNECTION SEVERED"];
        return headlines;

    } catch (error) {
        console.error("Telemetry error:", error);
        // Fallback cryptic messages
        return [
            "RARE SILVER IS IN LIMITED SUPPLY",
            "IT'S ILLEGAL TO STEAL IN STORE AIR",
            "INTERCEPTED BROKEN TRANSMISSION",
            "IS ANYONE THERE? THAT'S INTELLIGENT",
            "THE FEED IS DEAD."
        ];
    }
}
