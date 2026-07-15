import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Burner wallet generator — run by the USER (`npm run wallet`), never by
 * automation. Generates a fresh keypair, appends the key to .env with 0600
 * perms, and prints ONLY the public address. The key is never displayed,
 * logged, or sent anywhere; it exists only in .env on this machine.
 */

const ENV = path.resolve(import.meta.dirname, "../.env");

const existing = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
if (/^\s*PRIVATE_KEY\s*=/m.test(existing)) {
  console.error("A PRIVATE_KEY already exists in .env — refusing to overwrite.");
  console.error("If you really want a new wallet, move any funds out, delete the PRIVATE_KEY line manually, and re-run.");
  process.exit(1);
}

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

fs.appendFileSync(ENV, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}PRIVATE_KEY=${key}\n`, { mode: 0o600 });
fs.chmodSync(ENV, 0o600);

console.log(`
Burner wallet created. Address:

  ${account.address}

The private key was written to .env (permissions 0600). It is not shown here.
Back it up ONLY if you plan to hold meaningful funds — for a disposable test
burner, the .env copy is the wallet.

Next steps (yours to do):
  1. Send a small amount of ETH on ROBINHOOD CHAIN to the address above
     (Robinhood Wallet app supports the chain natively, or bridge via
     https://across.to / relay.link to chain id 4663).
  2. Check it arrived: https://robinhoodchain.blockscout.com/address/${account.address}
  3. In .env set:  LIVE=1  and  ARM_LIVE=I-UNDERSTAND-THE-RISKS
  4. Restart the agent yourself:  npm run dev
`);
