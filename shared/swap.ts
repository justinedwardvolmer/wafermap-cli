// Token swaps on Robinhood Chain and Base through the KyberSwap aggregator (public API, no
// key). Quotes and transactions are built where the wallet lives (browser or CLI): Kyber
// refuses calls from Cloudflare's servers, and the key never leaves the user's device anyway.
import { decodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

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

/** KyberSwap's MetaAggregationRouterV2, the only contract a swap may approve or call. The API's answer
 *  is checked against it, and the swap calldata is decoded and checked too (see executeSwap). */
export const KYBER_ROUTER: Record<Net, Address> = {
  robinhood: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  base: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
};

function checkRouter(net: Net, router: unknown): Address {
  const r = typeof router === "string" && isAddress(router) ? getAddress(router) : null;
  if (r !== KYBER_ROUTER[net]) throw new SwapError("unexpected_router", `The swap API named router ${String(router)}, not KyberSwap's router ${KYBER_ROUTER[net]} on ${net}. Nothing was approved or sent.`);
  return r;
}

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
    routerAddress: checkRouter(o.network, j.data.routerAddress),
    route: s,
    at: Date.now(),
  };
}

/** The two entry points of MetaAggregationRouterV2 that KyberSwap's build API returns. */
const SWAP_DESC = "(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)";
const ROUTER_ABI = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${SWAP_DESC} desc, bytes clientData) execution) payable returns (uint256, uint256)`,
  `function swapSimpleMode(address caller, ${SWAP_DESC} desc, bytes executorData, bytes clientData) returns (uint256, uint256)`,
]);

/**
 * What the calldata will make the router do, read from the bytes themselves rather than from what the
 * API says about them: which tokens, how much in, who receives the output, the minimum out, any fees.
 */
export function decodeSwap(data: Hex) {
  let d;
  try {
    d = decodeFunctionData({ abi: ROUTER_ABI, data });
  } catch {
    throw new SwapError("unexpected_calldata", "The swap API returned a call this wallet does not recognise. Nothing was sent.");
  }
  const desc = d.functionName === "swap" ? d.args[0].desc : d.args[1];
  return { fn: d.functionName, srcToken: getAddress(desc.srcToken), dstToken: getAddress(desc.dstToken), receiver: getAddress(desc.dstReceiver), amount: desc.amount, minReturn: desc.minReturnAmount, feeReceivers: desc.feeReceivers, feeAmounts: desc.feeAmounts };
}

/**
 * Build, check, approve (exact amount, only if needed) and send the swap from the wallet's account.
 * The built transaction is checked before anything is signed: KyberSwap's router, the quoted tokens and
 * amount, the output to this wallet, no fees, and a minimum output within the slippage of the quote.
 * Every step is reported through `step` so a UI can show progress.
 */
export async function executeSwap(o: { quote: SwapQuote; wallet: WalletClient; client: PublicClient; slippageBps?: number; fetch?: typeof fetch; step?: (s: string, tx?: Hex) => void }) {
  const f = o.fetch ?? fetch;
  const { quote } = o;
  const account = o.wallet.account;
  if (!account) throw new SwapError("no_account", "No wallet account to swap from.");
  if (Date.now() - quote.at > 90_000) throw new SwapError("stale_quote", "The quote is older than 90 seconds. Get a fresh one.");
  // A quote object could come from anywhere: approve and call only the pinned router.
  checkRouter(quote.network, quote.routerAddress);
  const from = account.address;
  const amountIn = parseUnits(quote.amountIn, quote.tokenIn.decimals ?? 18);
  const slippageBps = o.slippageBps ?? 100;
  if (!(slippageBps > 0 && slippageBps <= 500)) throw new SwapError("invalid_slippage", "Slippage must be above 0 and at most 5%.");
  const native = quote.tokenIn.address.toLowerCase() === NATIVE.toLowerCase();

  const eth = await o.client.getBalance({ address: from });
  if (eth === 0n) throw new SwapError("no_gas", `The wallet has no ETH on ${quote.network} to pay gas. Send a little ETH first.`);
  if (native ? eth < amountIn : (await o.client.readContract({ address: quote.tokenIn.address, abi: erc20Abi, functionName: "balanceOf", args: [from] })) < amountIn)
    throw new SwapError("insufficient_balance", `Not enough ${quote.tokenIn.symbol} in ${from.slice(0, 6)}…${from.slice(-4)}.`);

  // Build first (it needs no allowance), and check it, so a bad build never leaves an approval behind.
  o.step?.("building");
  const res = await f(`${KYBER(quote.network)}/route/build`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ routeSummary: quote.route, sender: from, recipient: from, slippageTolerance: slippageBps, deadline: Math.floor(Date.now() / 1000) + 1200, source: "wafermap" }),
  }).catch(() => null);
  const j: any = await res?.json().catch(() => null);
  if (!res?.ok || !j?.data?.data) throw new SwapError("build_failed", j?.message ? `Route build failed: ${j.message}` : "Could not build the swap. Get a fresh quote.");

  const b = j.data;
  const to = checkRouter(quote.network, b.routerAddress);
  const big = (v: unknown) => ((typeof v === "string" || typeof v === "number") && /^\d+$/.test(String(v)) ? BigInt(v) : null);
  const value = big(b.transactionValue ?? "0");
  const builtOut = big(b.amountOut);
  const quotedOut = parseUnits(quote.amountOut, quote.tokenOut.decimals ?? 18);
  const call = decodeSwap(b.data as Hex);
  const mismatch: (what: string) => never = (what) => {
    throw new SwapError("build_mismatch", `The built swap ${what}. Nothing was approved or sent.`);
  };
  if (call.srcToken !== getAddress(quote.tokenIn.address) || call.dstToken !== getAddress(quote.tokenOut.address)) mismatch("trades other tokens than the quote");
  if (call.amount !== amountIn) mismatch("spends a different amount than the quote");
  if (call.receiver !== getAddress(from)) mismatch(`sends the output to ${call.receiver}, not to this wallet`);
  if (call.feeAmounts.some((x) => x > 0n)) mismatch("takes a fee");
  if (value === null || value !== (native ? amountIn : 0n)) mismatch("sends a different amount of ETH than the quote");
  // The on-chain minimum must be the built output less your slippage, and the built output must be
  // within your slippage of the quote you approved.
  if (builtOut === null || builtOut * 10_000n < quotedOut * BigInt(10_000 - slippageBps)) throw new SwapError("price_moved", "The price moved past your slippage since the quote. Nothing was sent; get a fresh quote.");
  if (call.minReturn < (builtOut * BigInt(10_000 - slippageBps)) / 10_000n) mismatch("accepts less output than your slippage allows");

  let approveTx: Hex | undefined;
  if (!native) {
    const allowance = await o.client.readContract({ address: quote.tokenIn.address, abi: erc20Abi, functionName: "allowance", args: [from, to] });
    if (allowance < amountIn) {
      o.step?.("approving");
      approveTx = await o.wallet.writeContract({ address: quote.tokenIn.address, abi: erc20Abi, functionName: "approve", args: [to, amountIn], account, chain: o.wallet.chain });
      const r = await o.client.waitForTransactionReceipt({ hash: approveTx });
      if (r.status !== "success") throw new SwapError("approve_failed", "The approval transaction failed.");
    }
  }

  o.step?.("swapping");
  const tx = await o.wallet.sendTransaction({ to, data: b.data as Hex, value, account, chain: o.wallet.chain });
  const receipt = await o.client.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new SwapError("swap_reverted", "The swap reverted on-chain (price moved past your slippage). Nothing was swapped; gas was spent.");
  return { approveTx, tx, amountOutMin: formatUnits(call.minReturn, quote.tokenOut.decimals ?? 18) };
}
