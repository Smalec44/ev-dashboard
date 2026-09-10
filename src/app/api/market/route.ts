import type { MarketData } from "@/lib/types";
import { fetchNews } from "@/server/market/news";
import { fetchRegistrations } from "@/server/market/registrations";

/**
 * The market panel's data: registrations from the Federal Statistical Office
 * and headlines from an EV news feed, fetched fresh on every call. The two
 * fail independently, so a slow feed does not take the figures with it.
 */
export const maxDuration = 30;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function GET() {
  const [registrations, news] = await Promise.allSettled([
    fetchRegistrations(),
    fetchNews(),
  ]);
  const body: MarketData = {
    fetchedAt: new Date().toISOString(),
    registrations: registrations.status === "fulfilled" ? registrations.value : null,
    news: news.status === "fulfilled" ? news.value : null,
    errors: [
      ...(registrations.status === "rejected"
        ? [`registrations: ${message(registrations.reason)}`]
        : []),
      ...(news.status === "rejected" ? [`news: ${message(news.reason)}`] : []),
    ],
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
