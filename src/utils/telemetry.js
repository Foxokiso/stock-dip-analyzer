// Source headlines for the optional news overlay; failures never invent news.
import { getInvoke } from './bridge.js';

// Google News top stories. The overlay used to geolocate the user through a
// third-party IP lookup over plain HTTP to pick a city; the app no longer sends
// anything about the user anywhere, so the feed is the national front page.
export const NEWS_FEED_URL = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';

/**
 * Fetches the Google News RSS front page and returns up to ten headlines.
 * @returns {Promise<string[]>} Array of news headlines (empty on any failure)
 */
export async function getLocalNewsHeadlines() {
    try {
        const invoke = getInvoke();
        if (!invoke) throw new Error('Not running in Electron environment');
        const rssText = await invoke('fetch-url', NEWS_FEED_URL);

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(rssText, 'text/xml');
        const items = xmlDoc.querySelectorAll('item');

        const headlines = [];
        for (let i = 0; i < Math.min(items.length, 10); i++) {
            const titleElement = items[i].querySelector('title');
            if (!titleElement) continue;
            // Remove the source name (usually "- Source Name" at the end)
            let rawTitle = titleElement.textContent;
            const dashIndex = rawTitle.lastIndexOf(' - ');
            if (dashIndex > 0) rawTitle = rawTitle.substring(0, dashIndex);
            headlines.push(rawTitle);
        }
        return headlines;
    } catch (error) {
        console.error('Telemetry error:', error);
        return [];
    }
}
