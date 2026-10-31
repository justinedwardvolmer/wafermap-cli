// The Wafermap SDK. One class for an agent that holds its own key:
//   call()     pay-per-call Wafermap resources over x402
//   discover() search the open x402 index for third-party services
//   pay()      call any x402 URL and pay it (USDG on Robinhood Chain; USDC on Solana, Base, Arbitrum, Polygon)
//   swapQuote() / swap()  trade tokens through the KyberSwap aggregator
// Every payment is checked against per-payment and daily caps before anything is signed;
// swaps are checked against a per-swap cap. Nothing is ever sent to Wafermap but the signed
// payment header the x402 protocol requires.
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, isAddress, parseUnits, type Hex, type LocalAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, polygon, robinhood } from "viem/chains";
import { TOKENS, executeSwap, quoteSwap, resolveToken, type Net as SwapNet, type SwapQuote, type Token } from "../shared/swap";
import { latestBlockhash, solanaBalances, solanaKeyFromEvm, type SolanaPayer } from "../shared/solana";
import { CHAIN_KEYS, PAY_CHAINS, x402fetch, X402Error, type ChainKey, type Requirement } from "../shared/x402client";

/** A payment network. Swaps run on Robinhood Chain and Base only. */
export type Net = ChainKey;
type EvmNet = Exclude<Net, "solana">;
export const NETS: Net[] = CHAIN_KEYS;
export const isNet = (v: unknown): v is Net => NETS.includes(v as Net);
const isSwapNet = (v: unknown): v is SwapNet => v === "robinhood" || v === "base";
export type Limits = { perPayment: number; perDay: number; perSwap: number };
export type SpendEntry = { at: number; kind: "resource" | "service" | "swap"; what: string; usd: number; network: Net; tx: string | null; payer: string };
export type Approval = { kind: SpendEntry["kind"]; what: string; usd: number; network: Net; detail?: string };

export type WafermapOptions = {
  /** A 0x private key, or pass `account` (any viem LocalAccount). A private key also gives the
   *  wallet its Solana side (derived from it); with `account`, pass `solana` to pay on Solana. */
  privateKey?: Hex;
  account?: LocalAccount;
  /** Signs Solana payments. Derived from `privateKey` when not given. */
  solana?: Omit<SolanaPayer, "blockhash">;
  /** Read-only: a Solana address for balances when there is no key. */
  solanaAddress?: string;
  /** Default https://wafermap.xyz */
  baseUrl?: string;
  /** Preferred payment network. Default robinhood (USDG); base, arbitrum, polygon and solana pay in USDC. */
  network?: Net;
  limits?: Partial<Limits>;
  /** Where spending is remembered for the daily cap. Default: in memory. */
  ledger?: { entries(): SpendEntry[]; record(e: SpendEntry): void };
  /** Called before every payment or swap. Return false to refuse. Default: allow within caps. */
  approve?: (a: Approval) => boolean | Promise<boolean>;
  /** RPC URLs per network. Solana defaults to `${baseUrl}/api/solana`. */
  rpc?: Partial<Record<Net, string>>;
};

export class WafermapError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const CHAINS = { robinhood, base, arbitrum, polygon } as const;
export const DEFAULT_LIMITS: Limits = { perPayment: 0.1, perDay: 1, perSwap: 25 };

export class Wafermap {
  readonly account: LocalAccount;
  readonly baseUrl: string;
  network: Net;
  limits: Limits;
  private ledger: NonNullable<WafermapOptions["ledger"]>;
  private approveFn?: WafermapOptions["approve"];
  private rpc: Partial<Record<Net, string>>;
  private clients: Partial<Record<EvmNet, PublicClient>> = {};
  readonly solana: SolanaPayer | null;
  readonly solanaAddress: string | null;

  constructor(o: WafermapOptions) {
    const account = o.account ?? (o.privateKey ? privateKeyToAccount(o.privateKey) : null);
    if (!account) throw new WafermapError("no_account", "Pass privateKey or account.");
    this.account = account;
    this.baseUrl = (o.baseUrl ?? "https://wafermap.xyz").replace(/\/$/, "");
    this.network = o.network ?? "robinhood";
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    const mem: SpendEntry[] = [];
    this.ledger = o.ledger ?? { entries: () => mem, record: (e) => void mem.push(e) };
    this.approveFn = o.approve;
    this.rpc = o.rpc ?? {};
    const sol = o.solana ?? (o.privateKey ? solanaKeyFromEvm(o.privateKey) : null);
    const solRpc = this.rpc.solana ?? `${this.baseUrl}/api/solana`;
    this.solana = sol ? { address: sol.address, sign: sol.sign, blockhash: () => latestBlockhash(solRpc) } : null;
    this.solanaAddress = sol?.address ?? o.solanaAddress ?? null;
  }

  get address() {
    return this.account.address;
  }

  client(n: EvmNet): PublicClient {
    return (this.clients[n] ??= createPublicClient({ chain: CHAINS[n], transport: http(this.rpc[n]) }) as PublicClient);
  }

  /** USD spent today (local midnight) on payments, not counting swaps. */
  spentToday(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.ledger
      .entries()
      .filter((e) => e.kind !== "swap" && e.at >= start.getTime() && (e.payer.toLowerCase() === this.address.toLowerCase() || e.payer === this.solanaAddress))
      .reduce((a, e) => a + e.usd, 0);
  }

  private async gate(a: Approval) {
    if (a.kind === "swap") {
      if (a.usd > this.limits.perSwap) throw new WafermapError("over_swap_cap", `$${a.usd.toFixed(2)} is above the per-swap cap of $${this.limits.perSwap}.`);
    } else {
      if (a.usd > this.limits.perPayment) throw new WafermapError("over_payment_cap", `$${a.usd} is above the per-payment cap of $${this.limits.perPayment}.`);
      if (this.spentToday() + a.usd > this.limits.perDay + 1e-9) throw new WafermapError("over_daily_cap", `This would pass the daily cap of $${this.limits.perDay} ($${this.spentToday().toFixed(4)} spent today).`);
    }
    if (this.approveFn && !(await this.approveFn(a))) throw new WafermapError("declined", "Declined.");
  }

  private prefer(n?: Net): Net[] {
    const first = n ?? this.network;
    return [first, ...NETS.filter((x) => x !== first)];
  }

  /** A second 402 means the payment itself was refused (usually: not enough balance). */
  private rejected(res: Response, body: any, paid: { req: Requirement } | null) {
    if (!paid || res.status !== 402) return null;
    const reason = typeof body?.error === "string" ? body.error : (body?.error?.message ?? "rejected");
    return new WafermapError("payment_rejected", `Payment refused (${reason}). Check that ${paid.req.chain.vm === "svm" ? this.solanaAddress : this.address} holds at least $${paid.req.usd} ${paid.req.chain.symbol} on ${paid.req.chain.name}.`);
  }

  private async paidFetch(kind: "resource" | "service", what: string, url: string, init: RequestInit, network?: Net) {
    try {
      return await x402fetch(url, init, {
        signer: this.account as any,
        solana: this.solana ?? undefined,
        prefer: this.prefer(network),
        approve: (req: Requirement) => this.gate({ kind, what, usd: req.usd, network: req.chain.key, detail: `${req.chain.symbol} to ${req.payTo}` }),
      });
    } catch (e: any) {
      if (e instanceof WafermapError) throw e;
      if (e instanceof X402Error) throw new WafermapError(e.code, e.message);
      throw new WafermapError("network_error", `${new URL(url).host}: ${e?.cause?.message ?? e?.message ?? "request failed"}`);
    }
  }

  // ---- Wafermap resources ----

  async resources(): Promise<any[]> {
    const j: any = await fetch(`${this.baseUrl}/v1/resources`).then((r) => r.json());
    return j.data ?? [];
  }

  async call(id: string, input: Record<string, unknown> = {}, o: { network?: Net } = {}) {
    const go = () => this.paidFetch("resource", id, `${this.baseUrl}/v1/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, o.network);
    let { res, paid } = await go();
    let out: any = await res.json().catch(() => ({}));
    // The facilitator rotates its Solana fee payers; a quote that named one just rotated out is
    // refused before anything moves. Ask for a fresh quote once.
    if (paid?.req.chain.vm === "svm" && res.status === 402 && /fee_payer/i.test(JSON.stringify(out))) {
      ({ res, paid } = await go());
      out = await res.json().catch(() => ({}));
    }
    const refused = this.rejected(res, out, paid);
    if (refused) throw refused;
    if (!res.ok) throw new WafermapError(out?.error?.code ?? "http_error", out?.error?.message ?? (typeof out?.error === "string" ? out.error : `HTTP ${res.status}`));
    if (paid && out.receipt) this.ledger.record({ at: Date.now(), kind: "resource", what: id, usd: out.receipt.amountUsd, network: paid.req.chain.key, tx: out.receipt.tx, payer: paid.from });
    return out as { resource: string; result: any; receipt: { network: string; asset: string; amountUsd: number; payer: string; tx: string; ms: number } | null };
  }

  // ---- Third-party x402 services ----

  async discover(query: string, limit = 10) {
    const r = await fetch(`${this.baseUrl}/api/discover?q=${encodeURIComponent(query)}&limit=${limit}`);
    const j: any = await r.json().catch(() => null);
    if (!r.ok) throw new WafermapError(j?.error?.code ?? "discovery_failed", j?.error?.message ?? "Discovery is unavailable.");
    return j.services as { url: string; method: string; name: string | null; description: string; priceUsd: number | null; networks: string[]; payable: boolean; input: unknown; outputExample: unknown }[];
  }

  /** Call any x402 URL and pay it if it asks. GET sends `input` as the query string, POST as JSON. */
  async pay(url: string, o: { method?: "GET" | "POST"; input?: Record<string, unknown>; network?: Net } = {}) {
    const method = o.method ?? "GET";
    const qs = method === "GET" && o.input && Object.keys(o.input).length ? new URLSearchParams(Object.entries(o.input).map(([k, v]) => [k, String(v)])).toString() : "";
    const target = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
    const init: RequestInit = method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(o.input ?? {}) };
    const u = new URL(url);
    const { res, paid } = await this.paidFetch("service", `${u.host}${u.pathname}`, target, init, o.network);
    const type = res.headers.get("content-type") ?? "";
    const result = /json/.test(type) ? await res.json().catch(() => null) : /^(image|audio|video)\//.test(type) ? { bytes: (await res.arrayBuffer()).byteLength, contentType: type } : await res.text();
    const refused = this.rejected(res, result, paid);
    if (refused) throw refused;
    if (paid) this.ledger.record({ at: Date.now(), kind: "service", what: `${u.host}${u.pathname}`, usd: res.ok ? paid.req.usd : 0, network: paid.req.chain.key, tx: paid.tx, payer: paid.from });
    if (!res.ok) throw new WafermapError(paid ? "payment_failed" : "http_error", `${u.host} answered ${res.status}: ${JSON.stringify(result).slice(0, 300)}`);
    return { status: res.status, result, paid: paid ? { usd: paid.req.usd, network: paid.req.chain.key, tx: paid.tx } : null };
  }

  // ---- Wallet ----

  async balances() {
    const out = Object.fromEntries(NETS.map((n) => [n, null])) as Record<Net, { eth: string; gas: string; stable: string; symbol: string } | null>;
    const sol = this.solanaAddress;
    await Promise.all([
      sol
        ? solanaBalances(this.rpc.solana ?? `${this.baseUrl}/api/solana`, sol).then(
            (b) => void (out.solana = { eth: b.sol, gas: "SOL", stable: b.usdc, symbol: "USDC" }),
            () => {},
          )
        : null,
      ...NETS.filter((n): n is EvmNet => n !== "solana").map(async (n) => {
        try {
          const c = this.client(n);
          const chain = PAY_CHAINS.find((x) => x.key === n)!;
          const [eth, usd] = await Promise.all([c.getBalance({ address: this.address }), c.readContract({ address: chain.stable as Hex, abi: erc20Abi, functionName: "balanceOf", args: [this.address] })]);
          out[n] = { eth: formatUnits(eth, 18), gas: CHAINS[n].nativeCurrency.symbol, stable: formatUnits(usd as bigint, 6), symbol: chain.symbol };
        } catch {
          out[n] = null;
        }
      }),
    ]);
    return out;
  }

  // ---- Swaps ----

  private tokenCache: Partial<Record<SwapNet, Token[]>> = {};
  private async lookup(n: SwapNet, symbol: string) {
    if (!this.tokenCache[n]) {
      const j: any = await fetch(`${this.baseUrl}/api/tokens?network=${n}`)
        .then((r) => r.json())
        .catch(() => null);
      this.tokenCache[n] = j?.tokens ?? TOKENS[n];
    }
    return this.tokenCache[n]!.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
  }

  async swapQuote(from: string, to: string, amount: string, network?: Net): Promise<SwapQuote> {
    const n = network ?? (isSwapNet(this.network) ? this.network : "robinhood");
    if (!isSwapNet(n)) throw new WafermapError("unsupported_network", "Swaps run on Robinhood Chain or Base. Use --network robinhood or base.");
    // `as any`: shared/ is type-checked against the parent project's copy of viem.
    const c = this.client(n) as any;
    try {
      const [tokenIn, tokenOut] = await Promise.all([resolveToken(n, from, c, (net, s) => this.lookup(net, s)), resolveToken(n, to, c, (net, s) => this.lookup(net, s))]);
      return await quoteSwap({ network: n, tokenIn, tokenOut, amount });
    } catch (e: any) {
      throw new WafermapError(e?.code ?? "quote_failed", e?.shortMessage ?? e?.message ?? "No quote.");
    }
  }

  async swap(quote: SwapQuote, o: { slippageBps?: number; step?: (s: string) => void } = {}) {
    if (!quote.amountInUsd) throw new WafermapError("no_usd_value", "This swap has no USD value, so the per-swap cap cannot be checked. Not sent.");
    await this.gate({ kind: "swap", what: `${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, usd: quote.amountInUsd, network: quote.network, detail: `about ${quote.amountOut} ${quote.tokenOut.symbol}` });
    const wallet = createWalletClient({ account: this.account, chain: CHAINS[quote.network], transport: http(this.rpc[quote.network]) });
    try {
      const r = await executeSwap({ quote, wallet: wallet as any, client: this.client(quote.network) as any, slippageBps: o.slippageBps, step: o.step });
      this.ledger.record({ at: Date.now(), kind: "swap", what: `${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, usd: 0, network: quote.network, tx: r.tx, payer: this.address });
      return r;
    } catch (e: any) {
      throw new WafermapError(e?.code ?? "swap_failed", e?.shortMessage ?? e?.message ?? "Swap failed.");
    }
  }
}

export type { SwapQuote, Token };
