import type { MarketData } from "@/lib/types";
import { fetchNewsByRegion } from "@/server/market/news";
import { fetchRegistrations } from "@/server/market/registrations";

/**
 * The market panel's data: registrations from the Federal Statistical Office
 * and headlines from one EV news feed per region, fetched fresh on every call.
 * Every source fails independently, so a slow feed does not take the figures
 * — or the other regions — with it.
 */
export const maxDuration = 30;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function GET() {
  const [registrations, news] = await Promise.all([
    fetchRegistrations().then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error: `registrations: ${message(error)}` }),
    ),
    fetchNewsByRegion(),
  ]);
  const body: MarketData = {
    fetchedAt: new Date().toISOString(),
    registrations: registrations.value,
    news: news.news,
    errors: [...(registrations.error === null ? [] : [registrations.error]), ...news.errors],
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
