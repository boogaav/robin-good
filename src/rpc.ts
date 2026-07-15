import { Resolver, type LookupAddress } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

/**
 * The system resolver on this machine (Tailscale MagicDNS / hotspot DNS with a
 * filter list) null-routes rpc.mainnet.chain.robinhood.com to 127.0.0.1. The
 * network path itself is fine, so this process resolves hostnames via public
 * DNS (1.1.1.1 / 8.8.8.8) instead of the system resolver. App-level only — no
 * system or Tailscale settings are touched. Remove this module if the filter
 * is ever fixed upstream.
 */
const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

function lookup(
  hostname: string,
  opts: { all?: boolean },
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  resolver.resolve4(hostname, (err, addresses) => {
    if (err || !addresses?.length) return cb(err ?? new Error(`no A records for ${hostname}`), []);
    if (opts?.all) return cb(null, addresses.map((address) => ({ address, family: 4 })), 4);
    cb(null, addresses[0], 4);
  });
}

setGlobalDispatcher(new Agent({ connect: { lookup } }));
