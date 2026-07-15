import { createPublicClient, createWalletClient, defineChain, http, type WalletClient, type Account, type Chain, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, RPC_URL, EXPLORER, LIVE, PRIVATE_KEY } from "./config.js";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } }, // verified deployed
});

// NOTE: no transport-level JSON-RPC batching — Alchemy's Robinhood endpoint
// rejects request arrays ("JSON is not a valid request object"). Multicall
// batching below is the one that matters (N reads -> one eth_call).
export const pub = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL, { retryCount: 3, timeout: 15_000 }),
  batch: { multicall: { wait: 30 } },
});

export const account: Account | undefined = LIVE && PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : undefined;

export const wallet: WalletClient<Transport, Chain, Account> | undefined = account
  ? createWalletClient({ account, chain: robinhoodChain, transport: http(RPC_URL) })
  : undefined;
