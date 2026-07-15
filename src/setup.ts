import fs from "node:fs";
import path from "node:path";

/** First-run scaffold: .env from template (safe dry-run defaults) + guided next steps. */
const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env");

if (fs.existsSync(envPath)) {
  console.log(".env already exists — leaving it untouched.");
} else {
  fs.copyFileSync(path.join(root, ".env.example"), envPath);
  fs.chmodSync(envPath, 0o600);
  console.log("Created .env with safe defaults (DRY_RUN, small caps).");
}

console.log(`
Robin Good is ready. Next steps:

  1. npm run dev          # start in DRY_RUN — real market data, simulated fills
  2. npm run dash         # dashboard at http://localhost:5190
  3. npm run status       # positions, params, recent trades
     npm run reflect      # what the agent has learned

Let it paper-trade for at least a day. When (and only when) you want real
orders, read the "Going live" section of the README — it requires a funded
burner wallet and two explicit arming flags. Memecoins are extremely high
risk; use money you can afford to lose entirely.
`);
