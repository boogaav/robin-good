import fs from "node:fs";
import path from "node:path";
import { buildState } from "./dashboard.js";

/**
 * Render a static, read-only snapshot of the dashboard into public/ —
 * index.html (same UI; it falls back to ./state.json when /api/state is
 * absent) + state.json. scripts/publish.sh pushes it to GitHub Pages.
 * Contains only data that is already public on-chain (address, trades) or
 * harmless (params, lessons, log excerpts). Never touches keys.
 */
const root = path.resolve(import.meta.dirname, "..");
const pub = path.join(root, "public");
fs.mkdirSync(pub, { recursive: true });

const state = await buildState();
fs.writeFileSync(path.join(pub, "state.json"), JSON.stringify(state));
fs.copyFileSync(path.join(root, "src/dashboard.html"), path.join(pub, "index.html"));
console.log(`published snapshot: ${state.trades.length} trades, ${state.positions.length} open, wallet ${state.wallet?.ethBalance ?? "?"} ETH`);
