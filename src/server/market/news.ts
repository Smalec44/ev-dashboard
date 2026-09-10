import type { NewsItem } from "../../lib/types.ts";

/**
 * The latest EV headlines from electrive.com, the European e-mobility trade
 * outlet, via its RSS feed. Headlines and links only; the stories stay on
 * their site. Point EV_NEWS_FEED at another RSS 2.0 feed to swap the source.
 */
const DEFAULT_FEED = "https://www.electrive.com/feed/";
export const NEWS_COUNT = 5;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#039": "'",
  "#8217": "’",
  "#8216": "‘",
  "#8220": "“",
  "#8221": "”",
  "#8211": "–",
  "#8212": "—",
  nbsp: " ",
};

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#")) {
        const code = Number(entity.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .trim();
}

function tag(item: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(item);
  return match?.[1] === undefined ? null : decode(match[1]);
}

/**
 * Enough RSS 2.0 to read a headline feed. A full XML parser would be more
 * correct and pull in a dependency for three fields; the feed is well-formed
 * WordPress output and this fails soft on anything it does not understand.
 */
export function parseRss(xml: string, source: string, limit = NEWS_COUNT): NewsItem[] {
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1] ?? "";
    const title = tag(item, "title");
    const url = tag(item, "link");
    const published = tag(item, "pubDate");
    const at = published === null ? NaN : Date.parse(published);
    if (!title || !url || !/^https?:\/\//.test(url) || !Number.isFinite(at)) continue;
    items.push({ title, url, publishedAt: new Date(at).toISOString(), source });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchNews(): Promise<NewsItem[]> {
  const feed = process.env.EV_NEWS_FEED ?? DEFAULT_FEED;
  const res = await fetch(feed, {
    headers: { "User-Agent": "ev-dashboard/0.1 (+https://github.com/Smalec44/ev-dashboard)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${new URL(feed).hostname} returned ${res.status}`);
  return parseRss(await res.text(), new URL(feed).hostname.replace(/^www\./, ""));
}
