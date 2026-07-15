import { createPublicClient, createWalletClient, defineChain, http, type WalletClient, type Account, type Chain, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, RPC_URL, EXPLORER, LIVE, PRIVATE_KEY } from "./config.js";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});

export const pub = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL, { retryCount: 3, timeout: 15_000 }),
});

export const account: Account | undefined = LIVE && PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : undefined;

export const wallet: WalletClient<Transport, Chain, Account> | undefined = account
  ? createWalletClient({ account, chain: robinhoodChain, transport: http(RPC_URL) })
  : undefined;
