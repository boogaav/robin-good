import { EXPLORER } from "./config.js";
import { log } from "./util.js";

/**
 * Optional Telegram notifications. Set TELEGRAM_BOT_TOKEN (from @BotFather)
 * and TELEGRAM_CHAT_ID in .env to enable; silently disabled otherwise.
 * Fire-and-forget: a Telegram outage must never affect trading.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

export const notifierEnabled = !!(TOKEN && CHAT);

export function notify(html: string): void {
  if (!TOKEN || !CHAT) return;
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (r) => {
      if (!r.ok) log("notify", `telegram ${r.status}: ${(await r.text()).slice(0, 120)}`);
    })
    .catch((e) => log("notify", `telegram failed: ${(e as Error).message.slice(0, 80)}`));
}

export function proofLink(txHash: string | undefined, label: string): string {
  return txHash ? `<a href="${EXPLORER}/tx/${txHash}">${label}</a>` : "";
}
