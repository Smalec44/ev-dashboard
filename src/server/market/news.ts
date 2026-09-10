import type { NewsItem, NewsRegion } from "../../lib/types.ts";

/**
 * The latest EV headlines, one RSS feed per region. Headlines and links only;
 * the stories stay on their sites.
 *
 * - switzerland: electrive.net's Swiss tag — the German-language DACH edition
 *   of the same trade outlet, filtered to stories about Switzerland. There is
 *   no dedicated Swiss EV-news feed that answers (swiss-emobility.ch has none;
 *   auto.swiss and energie-experten.ch are general-purpose and sparse).
 *   English alternative: https://www.electrive.com/tag/switzerland/feed/ ,
 *   which runs a few weeks behind.
 * - europe: electrive.com, the European e-mobility trade outlet.
 * - world: InsideEVs, which covers EVs only (Electrek also works but mixes in
 *   solar and grid stories).
 *
 * Point EV_NEWS_FEED_<REGION> at another RSS 2.0 feed to swap a source. A
 * Google News search feed such as
 * https://news.google.com/rss/search?q=Elektroauto+Schweiz&hl=de-CH&gl=CH&ceid=CH:de
 * also parses, but Google's feed terms allow personal, non-commercial use
 * only, so it is not a default.
 */
const FEEDS: Record<NewsRegion, { env: string; url: string }> = {
  switzerland: {
    env: "EV_NEWS_FEED_SWITZERLAND",
    url: "https://www.electrive.net/tag/schweiz/feed/",
  },
  europe: { env: "EV_NEWS_FEED_EUROPE", url: "https://www.electrive.com/feed/" },
  world: { env: "EV_NEWS_FEED_WORLD", url: "https://insideevs.com/rss/articles/all/" },
};
export const NEWS_COUNT = 5;
const USER_AGENT = "ev-dashboard/0.1 (+https://github.com/Smalec44/ev-dashboard)";

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
 * The story URL: <link>, else a permalink <guid> (isPermaLink defaults to
 * true in RSS 2.0), else an Atom-style <link href="…"/>.
 */
function link(item: string): string | null {
  const plain = tag(item, "link");
  if (plain) return plain;
  const guid = /<guid(\s[^>]*)?>([\s\S]*?)<\/guid>/i.exec(item);
  if (guid?.[2] && !/isPermaLink\s*=\s*"false"/i.test(guid[1] ?? "")) return decode(guid[2]);
  const href = /<link\s[^>]*?href\s*=\s*"([^"]*)"/i.exec(item)?.[1];
  return href ? decode(href) : null;
}

/**
 * Enough RSS 2.0 to read a headline feed. A full XML parser would be more
 * correct and pull in a dependency for three fields; the feeds are well-formed
 * WordPress-style output and this fails soft on anything it does not understand.
 */
export function parseRss(xml: string, source: string, limit = NEWS_COUNT): NewsItem[] {
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1] ?? "";
    const title = tag(item, "title");
    const url = link(item);
    const published = tag(item, "pubDate");
    const at = published === null ? NaN : Date.parse(published);
    if (!title || !url || !/^https?:\/\//.test(url) || !Number.isFinite(at)) continue;
    items.push({ title, url, publishedAt: new Date(at).toISOString(), source });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchFeed(feed: string): Promise<NewsItem[]> {
  const hostname = new URL(feed).hostname;
  const res = await fetch(feed, {
    headers: { "User-Agent": USER_AGENT },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${hostname} returned ${res.status}`);
  return parseRss(await res.text(), hostname.replace(/^www\./, ""));
}

/**
 * All three regions at once. A feed that fails leaves its region null and an
 * error line; the others are unaffected. Never throws.
 */
export async function fetchNewsByRegion(): Promise<{
  news: Record<NewsRegion, NewsItem[] | null>;
  errors: string[];
}> {
  const regions = Object.keys(FEEDS) as NewsRegion[];
  const results = await Promise.allSettled(
    regions.map((region) => fetchFeed(process.env[FEEDS[region].env] ?? FEEDS[region].url)),
  );
  const news = { switzerland: null, europe: null, world: null } as Record<
    NewsRegion,
    NewsItem[] | null
  >;
  const errors: string[] = [];
  regions.forEach((region, i) => {
    const result = results[i];
    if (result?.status === "fulfilled") news[region] = result.value;
    else {
      const reason: unknown = result?.reason;
      errors.push(`news/${region}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  });
  return { news, errors };
}
