import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./util.js";

const exec = promisify(execFile);

/**
 * GMGN token-security screen via the locally configured gmgn-cli (query-tier
 * auth only). Advisory layer: a positive honeypot/alert flag is a hard
 * reject; missing data (brand-new tokens aren't indexed yet) or CLI failure
 * NEVER blocks — the other four defenses still apply. Everything observed is
 * journaled so the learner can measure how predictive these flags are.
 */
export type GmgnScreen = {
  ok: boolean;
  reason: string;
  features: Record<string, number>;
};

const cache = new Map<string, { at: number; res: GmgnScreen }>();
const CACHE_MS = 10 * 60_000;

export async function gmgnScreen(token: `0x${string}`): Promise<GmgnScreen> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.res;

  let res: GmgnScreen;
  try {
    const { stdout } = await exec("gmgn-cli", ["token", "security", "--chain", "robinhood", "--address", token, "--raw"], { timeout: 8000 });
    const j = JSON.parse(stdout) as {
      is_honeypot?: boolean | null;
      is_show_alert?: boolean | null;
      is_open_source?: boolean | null;
      is_renounced?: boolean | null;
      top_10_holder_rate?: string;
      sell_tax?: string;
      lock_summary?: { is_locked?: boolean };
    };
    const features: Record<string, number> = {
      gmgnChecked: 1,
      gmgnHoneypot: j.is_honeypot === true ? 1 : j.is_honeypot === false ? 0 : -1,
      gmgnAlert: j.is_show_alert === true ? 1 : 0,
      gmgnOpenSource: j.is_open_source === true ? 1 : j.is_open_source === false ? 0 : -1,
      gmgnRenounced: j.is_renounced === true ? 1 : j.is_renounced === false ? 0 : -1,
      gmgnTop10Rate: j.top_10_holder_rate ? Number(j.top_10_holder_rate) : -1,
      gmgnSellTax: j.sell_tax ? Number(j.sell_tax) : -1,
      gmgnLpLocked: j.lock_summary?.is_locked === true ? 1 : 0,
    };
    if (j.is_honeypot === true) res = { ok: false, reason: "GMGN flags honeypot", features };
    else if (j.is_show_alert === true) res = { ok: false, reason: "GMGN scam alert", features };
    else if (j.sell_tax && Number(j.sell_tax) > 0.1) res = { ok: false, reason: `GMGN sell tax ${j.sell_tax}`, features };
    else res = { ok: true, reason: "gmgn pass", features };
  } catch (e) {
    // CLI missing, rate-limited, or token not indexed yet — advisory only.
    log("gmgn", `screen unavailable for ${token}: ${(e as Error).message.slice(0, 80)}`);
    res = { ok: true, reason: "gmgn unavailable", features: { gmgnChecked: 0 } };
  }
  cache.set(key, { at: Date.now(), res });
  return res;
}
