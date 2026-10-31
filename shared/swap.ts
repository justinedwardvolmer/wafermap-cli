// Token swaps on Robinhood Chain and Base through the KyberSwap aggregator (public API, no
// key). Quotes and transactions are built where the wallet lives (browser or CLI): Kyber
// refuses calls from Cloudflare's servers, and the key never leaves the user's device anyway.
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

export type Net = "robinhood" | "base";
export type Token = { symbol: string; name: string; address: Address; decimals: number | null; kind?: "native" | "stable" | "wrapped" | "stock" };

export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export const TOKENS: Record<Net, Token[]> = {
  robinhood: [
    { symbol: "ETH", name: "Ether", address: NATIVE, decimals: 18, kind: "native" },
    { symbol: "WETH", name: "Wrapped Ether", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18, kind: "wrapped" },
    { symbol: "USDG", name: "Global Dollar", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, kind: "stable" },
  ],
  base: [
    { symbol: "ETH", name: "Ether", address: NATIVE, decimals: 18, kind: "native" },
    { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18, kind: "wrapped" },
    { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, kind: "stable" },
  ],
};

const KYBER = (net: Net) => `https://aggregator-api.kyberswap.com/${net}/api/v1`;
const HEADERS = { "x-client-id": "wafermap", accept: "application/json" };

export class SwapError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve "ETH", "USDC", "TSLA" or a 0x address to a token with decimals.
 * `lookup` finds symbols outside the built-in list (e.g. Robinhood stock tokens).
 */
export async function resolveToken(net: Net, ref: string, client: PublicClient, lookup?: (net: Net, symbol: string) => Promise<Token | null>): Promise<Token> {
  const r = ref.trim();
  let t: Token | null = null;
  if (isAddress(r)) t = TOKENS[net].find((x) => x.address.toLowerCase() === r.toLowerCase()) ?? { symbol: "?", name: "", address: getAddress(r), decimals: null };
  else t = TOKENS[net].find((x) => x.symbol.toLowerCase() === r.toLowerCase()) ?? (lookup ? await lookup(net, r) : null);
  if (!t) throw new SwapError("unknown_token", `Unknown token "${r}" on ${net}. Use a symbol (ETH, ${net === "base" ? "USDC" : "USDG, TSLA"}) or a 0x address.`);
  if (t.decimals === null || t.symbol === "?") {
    const [dec, sym] = await client.multicall({ contracts: [{ address: t.address, abi: erc20Abi, functionName: "decimals" }, { address: t.address, abi: erc20Abi, functionName: "symbol" }], allowFailure: true });
    if (dec.status !== "success") throw new SwapError("not_a_token", `${t.address} is not an ERC-20 token on ${net}.`);
    t = { ...t, decimals: Number(dec.result), symbol: t.symbol === "?" && sym.status === "success" ? String(sym.result) : t.symbol };
  }
  return t;
}

export type SwapQuote = {
  network: Net;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string;
  amountOut: string;
  amountInUsd: number | null;
  amountOutUsd: number | null;
  gasUsd: number | null;
  /** Percent lost between USD in and USD out (route fees + impact), when both are known. */
  impactPct: number | null;
  routerAddress: Address;
  route: unknown;
  at: number;
};

/** Ask Kyber for the best route. `amount` is human units of tokenIn ("0.5"). */
export async function quoteSwap(o: { network: Net; tokenIn: Token; tokenOut: Token; amount: string; fetch?: typeof fetch }): Promise<SwapQuote> {
  const f = o.fetch ?? fetch;
  if (o.tokenIn.address.toLowerCase() === o.tokenOut.address.toLowerCase()) throw new SwapError("same_token", "Pick two different tokens.");
  let units: bigint;
  try {
    units = parseUnits(o.amount, o.tokenIn.decimals ?? 18);
  } catch {
    throw new SwapError("invalid_amount", `"${o.amount}" is not an amount.`);
  }
  if (units <= 0n) throw new SwapError("invalid_amount", "Amount must be above zero.");
  const q = new URLSearchParams({ tokenIn: o.tokenIn.address, tokenOut: o.tokenOut.address, amountIn: units.toString(), gasInclude: "true" });
  const res = await f(`${KYBER(o.network)}/routes?${q}`, { headers: HEADERS }).catch(() => null);
  const j: any = await res?.json().catch(() => null);
  const s = j?.data?.routeSummary;
  if (!res?.ok || !s) throw new SwapError("no_route", j?.message && j.message !== "successfully" ? `No route: ${j.message}` : "No swap route found for that pair and size.");
  const inUsd = Number(s.amountInUsd);
  const outUsd = Number(s.amountOutUsd);
  return {
    network: o.network,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amountIn: o.amount,
    amountOut: formatUnits(BigInt(s.amountOut), o.tokenOut.decimals ?? 18),
    amountInUsd: Number.isFinite(inUsd) && inUsd > 0 ? inUsd : null,
    amountOutUsd: Number.isFinite(outUsd) && outUsd > 0 ? outUsd : null,
    gasUsd: Number(s.gasUsd) || null,
    impactPct: inUsd > 0 && outUsd > 0 ? Math.round((1 - outUsd / inUsd) * 10000) / 100 : null,
    routerAddress: getAddress(j.data.routerAddress),
    route: s,
    at: Date.now(),
  };
}

/**
 * Approve (exact amount, only if needed) and send the swap from the wallet's account.
 * Every step is reported through `step` so a UI can show progress.
 */
export async function executeSwap(o: { quote: SwapQuote; wallet: WalletClient; client: PublicClient; slippageBps?: number; fetch?: typeof fetch; step?: (s: string, tx?: Hex) => void }) {
  const f = o.fetch ?? fetch;
  const { quote } = o;
  const account = o.wallet.account;
  if (!account) throw new SwapError("no_account", "No wallet account to swap from.");
  if (Date.now() - quote.at > 90_000) throw new SwapError("stale_quote", "The quote is older than 90 seconds. Get a fresh one.");
  const from = account.address;
  const amountIn = parseUnits(quote.amountIn, quote.tokenIn.decimals ?? 18);
  const native = quote.tokenIn.address.toLowerCase() === NATIVE.toLowerCase();

  const eth = await o.client.getBalance({ address: from });
  if (eth === 0n) throw new SwapError("no_gas", `The wallet has no ETH on ${quote.network} to pay gas. Send a little ETH first.`);
  if (native ? eth < amountIn : (await o.client.readContract({ address: quote.tokenIn.address, abi: erc20Abi, functionName: "balanceOf", args: [from] })) < amountIn)
    throw new SwapError("insufficient_balance", `Not enough ${quote.tokenIn.symbol} in ${from.slice(0, 6)}…${from.slice(-4)}.`);

  let approveTx: Hex | undefined;
  if (!native) {
    const allowance = await o.client.readContract({ address: quote.tokenIn.address, abi: erc20Abi, functionName: "allowance", args: [from, quote.routerAddress] });
    if (allowance < amountIn) {
      o.step?.("approving");
      approveTx = await o.wallet.writeContract({ address: quote.tokenIn.address, abi: erc20Abi, functionName: "approve", args: [quote.routerAddress, amountIn], account, chain: o.wallet.chain });
      const r = await o.client.waitForTransactionReceipt({ hash: approveTx });
      if (r.status !== "success") throw new SwapError("approve_failed", "The approval transaction failed.");
    }
  }

  o.step?.("building");
  const res = await f(`${KYBER(quote.network)}/route/build`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ routeSummary: quote.route, sender: from, recipient: from, slippageTolerance: o.slippageBps ?? 100, deadline: Math.floor(Date.now() / 1000) + 1200, source: "wafermap" }),
  }).catch(() => null);
  const j: any = await res?.json().catch(() => null);
  if (!res?.ok || !j?.data?.data) throw new SwapError("build_failed", j?.message ? `Route build failed: ${j.message}` : "Could not build the swap. Get a fresh quote.");

  o.step?.("swapping");
  const tx = await o.wallet.sendTransaction({ to: getAddress(j.data.routerAddress), data: j.data.data as Hex, value: BigInt(j.data.transactionValue ?? "0"), account, chain: o.wallet.chain });
  const receipt = await o.client.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new SwapError("swap_reverted", "The swap reverted on-chain (price moved past your slippage). Nothing was swapped; gas was spent.");
  return { approveTx, tx, amountOutMin: formatUnits(BigInt(j.data.amountOut ?? "0"), quote.tokenOut.decimals ?? 18) };
}
