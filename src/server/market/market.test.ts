import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchNewsByRegion, parseRss } from "./news.ts";
import { summariseRegistrations } from "./registrations.ts";

test("registrations fold fuel rows into a BEV count and a total per year", () => {
  const years = summariseRegistrations({
    columns: [
      { code: "Fahrzeuggruppe", type: "d" },
      { code: "Treibstoff", type: "d" },
      { code: "Jahr", type: "t" },
      { code: "Neue Inverkehrsetzungen", type: "c" },
    ],
    data: [
      { key: ["100", "100", "2024"], values: ["70000"] },
      { key: ["100", "500", "2024"], values: ["46581"] },
      { key: ["100", "500", "2023"], values: ["52929"] },
      { key: ["100", "100", "2023"], values: ["85205"] },
    ],
  });
  assert.deepEqual(years, [
    { year: 2023, bev: 52929, total: 138134 },
    { year: 2024, bev: 46581, total: 116581 },
  ]);
});

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>Lidl GB cuts EV charging tariffs &amp; invests &#163;10m</title>
<link>https://www.electrive.com/2026/09/09/lidl/</link>
<pubDate>Wed, 09 Sep 2026 17:15:00 +0000</pubDate>
<description><![CDATA[<div>ignored</div>]]></description></item>
<item><title><![CDATA[Enercity&#8217;s V2G trial]]></title>
<link>https://www.electrive.com/2026/09/09/enercity/</link>
<pubDate>Wed, 09 Sep 2026 17:00:00 +0000</pubDate></item>
<item><title>No link</title><pubDate>Wed, 09 Sep 2026 16:00:00 +0000</pubDate></item>
<item><title>Bad date</title><link>https://x.example/</link><pubDate>soon</pubDate></item>
</channel></rss>`;

test("the RSS reader keeps well-formed items, decodes entities and drops the rest", () => {
  const items = parseRss(FEED, "electrive.com");
  assert.equal(items.length, 2);
  const [first, second] = items;
  assert.ok(first && second);
  assert.equal(first.title, "Lidl GB cuts EV charging tariffs & invests £10m");
  assert.equal(first.publishedAt, "2026-09-09T17:15:00.000Z");
  assert.equal(second.title, "Enercity’s V2G trial");
  assert.equal(second.source, "electrive.com");
});

test("the RSS reader stops at the requested count", () => {
  assert.equal(parseRss(FEED, "x", 1).length, 1);
});

const LINKLESS = `<rss version="2.0"><channel>
<item><title>Permalink guid</title><link></link>
<guid isPermaLink="true">https://x.example/guid</guid>
<pubDate>Wed, 09 Sep 2026 17:00:00 +0000</pubDate></item>
<item><title>Bare guid</title><guid>https://x.example/bare</guid>
<pubDate>Wed, 09 Sep 2026 16:00:00 +0000</pubDate></item>
<item><title>Opaque guid</title><guid isPermaLink="false">https://x.example/?p=1</guid>
<pubDate>Wed, 09 Sep 2026 15:00:00 +0000</pubDate></item>
<item><title>Atom href</title><link rel="alternate" href="https://x.example/atom"/>
<pubDate>Wed, 09 Sep 2026 14:00:00 +0000</pubDate></item>
<item><title>Nothing usable</title><guid>urn:uuid:1</guid>
<pubDate>Wed, 09 Sep 2026 13:00:00 +0000</pubDate></item>
</channel></rss>`;

test("the RSS reader falls back to a permalink guid or an Atom href when <link> is empty", () => {
  assert.deepEqual(
    parseRss(LINKLESS, "x").map((item) => item.url),
    ["https://x.example/guid", "https://x.example/bare", "https://x.example/atom"],
  );
});

test("news fetches every region and reports each failure by region", async (t) => {
  const responses: Record<string, () => Response> = {
    "www.electrive.net": () => new Response(FEED),
    "www.electrive.com": () => new Response("down", { status: 503 }),
    "insideevs.com": () => {
      throw new TypeError("fetch failed");
    },
  };
  const fetchMock = t.mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const respond = responses[url.hostname];
    assert.ok(respond, `unexpected fetch of ${url.href}`);
    return Promise.resolve(respond());
  });
  const { news, errors } = await fetchNewsByRegion();
  assert.equal(fetchMock.mock.callCount(), 3);
  assert.ok(news.switzerland);
  assert.equal(news.switzerland.length, 2);
  assert.equal(news.switzerland[0]?.source, "electrive.net");
  assert.equal(news.europe, null);
  assert.equal(news.world, null);
  assert.deepEqual(errors, [
    "news/europe: www.electrive.com returned 503",
    "news/world: fetch failed",
  ]);
});
