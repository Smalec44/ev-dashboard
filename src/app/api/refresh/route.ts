import type { NextRequest } from "next/server";
import { scopeFromParams, inScope, type RefreshResponse } from "@/lib/refresh";
import { enrich } from "@/server/pipeline/enrich";
import {
  EVSE_URL,
  STATUS_URL,
  attachLiveStatus,
  buildSites,
  parseFeed,
  parseStatus,
  publishSite,
} from "@/server/pipeline/feed";
import { cellBboxes } from "@/server/pipeline/geo";

/**
 * Rebuilds the stations inside one search area from the live sources: the
 * federal feed (sites, stalls, power), its status feed (which stalls are free
 * right now) and OpenStreetMap (food, green space, parking terms).
 *
 * Long trips fan out into dozens of Overpass batches; the limit is generous
 * enough for the slider's maximum, and well inside what a free host allows.
 */
export const maxDuration = 120;

/**
 * Two clicks in a row should not pull the 25 MB feed twice. Held per server
 * instance for a minute; the status feed is small and always fetched fresh.
 */
const FEED_MEMO_MS = 60_000;
let feedMemo: { at: number; buffer: Uint8Array } | null = null;

/** Beyond this the refresh would take minutes; the response says to narrow the search. */
const MAX_CELLS = 80;

const OVERPASS_ENDPOINTS = process.env.OVERPASS_ENDPOINTS?.split(",")
  .map((url) => url.trim())
  .filter(Boolean);

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${new URL(url).pathname.split("/").pop()} returned ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFeed(): Promise<Uint8Array> {
  if (feedMemo && Date.now() - feedMemo.at < FEED_MEMO_MS) return feedMemo.buffer;
  const buffer = await download(EVSE_URL);
  feedMemo = { at: Date.now(), buffer };
  return buffer;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function GET(request: NextRequest) {
  const scope = scopeFromParams(request.nextUrl.searchParams);
  if (!scope) {
    return Response.json(
      { error: "Missing or malformed search area." },
      { status: 400 },
    );
  }

  const [feedResult, statusResult] = await Promise.allSettled([
    loadFeed(),
    download(STATUS_URL),
  ]);
  if (feedResult.status === "rejected") {
    return Response.json(
      { error: `The federal charging feed is unavailable (${message(feedResult.reason)}).` },
      { status: 502 },
    );
  }

  const refreshedAt = new Date().toISOString();
  const errors: string[] = [];
  const sites = buildSites(parseFeed(feedResult.value)).filter((site) =>
    inScope(scope, site),
  );
  if (statusResult.status === "fulfilled") {
    attachLiveStatus(sites, parseStatus(statusResult.value), refreshedAt);
  } else {
    errors.push(`status: ${message(statusResult.reason)}`);
  }

  if (cellBboxes(sites).length > MAX_CELLS) {
    return Response.json(
      { error: "This search area is too large to refresh live — shorten the detour or radius." },
      { status: 422 },
    );
  }

  const result = await enrich(sites, {
    parallel: true,
    parkingScope: "cells",
    overpass: {
      ...(OVERPASS_ENDPOINTS && { endpoints: OVERPASS_ENDPOINTS }),
      // A request cannot wait out a rate limit the way the offline build can.
      rounds: 2,
      backoffMs: 3_000,
      maxRetryWaitMs: 10_000,
      timeoutSeconds: 60,
      concurrency: 3,
    },
  });

  const body: RefreshResponse = {
    refreshedAt,
    stations: sites.map(publishSite),
    foodAvailable: result.foodAvailable,
    greenAvailable: result.greenAvailable,
    parkingAvailable: result.parkingAvailable,
    errors: [...errors, ...result.errors],
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
