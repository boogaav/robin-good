import { getAddress } from "viem";
import { findWethPool, type PoolInfo } from "./market.js";
import { log } from "./util.js";

/**
 * OPTIONAL X (Twitter) influencer watchlist. OFF unless X_BEARER_TOKEN is set.
 *
 * Honest constraints (read before enabling):
 *  - The X API is PAID. Basic tier (~$200/mo) is the realistic minimum for
 *    polling user timelines; there is no free firehose.
 *  - Most viral crypto tweets are about tokens on OTHER chains (Base, Solana).
 *    We can only trade Robinhood Chain, so a tweet only becomes actionable when
 *    it names a token that HAS a WETH pool here — a low hit rate by nature.
 *  - This monitors a WATCHLIST of accounts (X_WATCHLIST), not all of X. It
 *    extracts 0x contract addresses from their recent posts and checks each for
 *    a tradeable pool. Cashtags ($NAME) are logged but not auto-traded — too
 *    ambiguous to map to an address safely.
 *
 * When it finds a fresh contract address from a watched account with a pool,
 * it emits a SocialCandidate that flows through the normal safety gate. It
 * never bypasses any check.
 */

const BEARER = process.env.X_BEARER_TOKEN;
const WATCHLIST = (process.env.X_WATCHLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const xEnabled = !!BEARER && WATCHLIST.length > 0;

export type XCandidate = {
  kind: "social";
  info: PoolInfo;
  price: number;
  features: Record<string, number>;
  source: string; // "@handle"
};

const seenTweets = new Set<string>();
const userIdCache = new Map<string, string>();
const CONTRACT_RE = /0x[a-fA-F0-9]{40}/g;

async function xGet(path: string): Promise<unknown> {
  const res = await fetch(`https://api.twitter.com/2/${path}`, {
    headers: { Authorization: `Bearer ${BEARER}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`x api ${res.status}`);
  return res.json();
}

async function resolveUserId(handle: string): Promise<string | null> {
  const h = handle.replace(/^@/, "");
  if (userIdCache.has(h)) return userIdCache.get(h)!;
  try {
    const j = (await xGet(`users/by/username/${h}`)) as { data?: { id: string } };
    if (j.data?.id) { userIdCache.set(h, j.data.id); return j.data.id; }
  } catch (e) {
    log("x", `resolve @${h} failed: ${(e as Error).message.slice(0, 60)}`);
  }
  return null;
}

/** Poll each watched account's recent tweets for fresh contract addresses. */
export async function pollX(): Promise<XCandidate[]> {
  if (!xEnabled) return [];
  const out: XCandidate[] = [];
  for (const handle of WATCHLIST) {
    const uid = await resolveUserId(handle);
    if (!uid) continue;
    try {
      const j = (await xGet(`users/${uid}/tweets?max_results=5&tweet.fields=public_metrics`)) as {
        data?: { id: string; text: string; public_metrics?: { impression_count?: number } }[];
      };
      for (const tw of j.data ?? []) {
        if (seenTweets.has(tw.id)) continue;
        seenTweets.add(tw.id);
        const addrs = tw.text.match(CONTRACT_RE) ?? [];
        const views = tw.public_metrics?.impression_count ?? 0;
        for (const addr of addrs) {
          let info: PoolInfo | null;
          try { info = await findWethPool(getAddress(addr)); } catch { continue; }
          if (!info) continue;
          log("x", `@${handle} posted tradeable token ${info.symbol} (${views} views)`);
          out.push({ kind: "social", info, price: 0, source: `@${handle}`, features: { xViews: views, xSignal: 1 } });
        }
      }
    } catch (e) {
      log("x", `poll @${handle} failed: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  return out;
}
