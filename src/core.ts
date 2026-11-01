// The Wafermap SDK. One class for an agent that holds its own key:
//   call()     pay-per-call Wafermap resources over x402
//   discover() search the open x402 index for third-party services
//   pay()      call any x402 URL and pay it (USDG on Robinhood Chain; USDC on Solana, Base, Arbitrum, Polygon)
//   swapQuote() / swap()  trade tokens through the KyberSwap aggregator
// Every payment is checked against per-payment and daily caps before anything is signed;
// swaps are checked against a per-swap cap. The daily cap counts what this wallet signed, at the
// full signed amount, the moment it is signed: never what a server reports it charged.
// Nothing is ever sent to Wafermap but the signed payment header the x402 protocol requires.
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, getAddress, http, isAddress, parseUnits, type Hex, type LocalAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, polygon, robinhood } from "viem/chains";
import { TOKENS, executeSwap, quoteSwap, resolveToken, type Net as SwapNet, type SwapQuote, type Token } from "../shared/swap";
import { latestBlockhash, solanaBalances, solanaKeyFromEvm, type SolanaPayer } from "../shared/solana";
import { CHAIN_KEYS, PAY_CHAINS, x402fetch, X402Error, type ChainKey, type Requirement, type Signed } from "../shared/x402client";

/** A payment network. Swaps run on Robinhood Chain and Base only. */
export type Net = ChainKey;
type EvmNet = Exclude<Net, "solana">;
export const NETS: Net[] = CHAIN_KEYS;
export const isNet = (v: unknown): v is Net => NETS.includes(v as Net);
const isSwapNet = (v: unknown): v is SwapNet => v === "robinhood" || v === "base";
export type Limits = { perPayment: number; perDay: number; perSwap: number };
/**
 * One line of the spend log. A payment writes two lines: the signed amount the moment it is
 * signed (`status: "signed"`, counted by the daily cap), then the outcome with `usd: 0` and
 * `of` pointing back to it. Older logs have single lines without `id`; `mergeLog` joins them.
 */
export type SpendEntry = {
  at: number;
  kind: "resource" | "service" | "swap";
  what: string;
  usd: number;
  network: Net;
  tx: string | null;
  payer: string;
  id?: string;
  of?: string;
  status?: PaymentStatus;
  /** EVM payments: the EIP-3009 nonce and expiry, to check on-chain whether it was ever used. */
  nonce?: string;
  validBefore?: number;
  /** What the server said it charged, for the record only. */
  reported?: number | null;
};
/** signed: sent, outcome not known (or the request died) · ok: the server answered 2xx ·
 *  failed: it answered with an error · refused: it refused the payment itself ·
 *  aborted: signed but never sent, because another process had used the budget meanwhile. */
export type PaymentStatus = "signed" | "ok" | "failed" | "refused" | "aborted";
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
  /** Give up on any HTTP request (quote, paid call, discovery, swap API) after this long. Default 60000 ms.
   *  A paid call that times out after signing stays counted until its authorization expires. */
  timeoutMs?: number;
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
const AUTH_STATE_ABI = [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] }] as const;

/** One row per payment: the signed line joined with its outcome line. Old single lines pass through. */
export function mergeLog(entries: SpendEntry[]): SpendEntry[] {
  const outcomes = new Map(entries.filter((e) => e.of).map((e) => [e.of!, e]));
  return entries
    .filter((e) => !e.of)
    .map((e) => {
      const o = e.id ? outcomes.get(e.id) : undefined;
      if (!o) return e;
      return { ...e, status: o.status, tx: o.tx ?? e.tx, reported: o.reported ?? null, ...(o.status === "aborted" ? { usd: 0 } : {}) };
    });
}

/**
 * Was a signed payment ever executed? Reads the token contract (EIP-3009 authorizationState),
 * so the answer does not depend on any server and needs no key. "unused" after expiry means it
 * can never be charged. Solana payments and old log lines without a nonce come back "unknown"; an RPC
 * failure comes back "error".
 */
export async function checkPayment(e: Pick<SpendEntry, "network" | "payer" | "nonce" | "validBefore">, rpc?: string): Promise<"used" | "unused" | "pending" | "unknown" | "error"> {
  if (e.network === "solana" || !e.nonce || !(e.network in CHAINS)) return "unknown";
  const chain = PAY_CHAINS.find((c) => c.key === e.network)!;
  try {
    const client = createPublicClient({ chain: CHAINS[e.network as EvmNet], transport: http(rpc) });
    const used = await client.readContract({ address: chain.stable as Hex, abi: AUTH_STATE_ABI, functionName: "authorizationState", args: [e.payer as Hex, e.nonce as Hex] });
    if (used) return "used";
    return e.validBefore && Date.now() / 1000 > e.validBefore ? "unused" : "pending";
  } catch {
    return "error"; // the RPC could not answer: the payment may or may not have been executed
  }
}

export const DEFAULT_LIMITS: Limits = { perPayment: 0.1, perDay: 1, perSwap: 25 };
export const DEFAULT_TIMEOUT_MS = 60_000;

const timedOut = (e: any) => e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";

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
  readonly timeoutMs: number;
  /** fetch with this wallet's time limit: a server that never answers cannot hold a call forever. */
  readonly fetch: typeof fetch;

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
    this.timeoutMs = o.timeoutMs && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs) });
    const sol = o.solana ?? (o.privateKey ? solanaKeyFromEvm(o.privateKey) : null);
    const solRpc = this.rpc.solana ?? `${this.baseUrl}/api/solana`;
    this.solana = sol ? { address: sol.address, sign: sol.sign, blockhash: () => latestBlockhash(solRpc, this.fetch) } : null;
    this.solanaAddress = sol?.address ?? o.solanaAddress ?? null;
  }

  get address() {
    return this.account.address;
  }

  client(n: EvmNet): PublicClient {
    return (this.clients[n] ??= createPublicClient({ chain: CHAINS[n], transport: http(this.rpc[n]) }) as PublicClient);
  }

  /** USD signed today (local midnight) on payments, not counting swaps. Every signed payment
   *  counts at its full amount, whatever the server answered, because a signed payment can be
   *  executed until it expires. `checkPayment` shows on-chain which ones were never used. */
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

  /** Write the signed payment to the ledger before it leaves the machine. */
  private booked(kind: "resource" | "service", what: string, s: Signed): string {
    const id = crypto.randomUUID();
    this.ledger.record({ at: Date.now(), kind, what, usd: s.req.usd, network: s.req.chain.key, tx: null, payer: s.from, id, status: "signed", ...(s.auth ? { nonce: s.auth.nonce, validBefore: s.auth.validBefore } : {}) });
    return id;
  }

  /** The outcome line for a booked payment. It adds nothing to the daily total. */
  private outcome(id: string, kind: "resource" | "service", what: string, s: Signed, status: PaymentStatus, tx: string | null, reported: number | null = null) {
    this.ledger.record({ at: Date.now(), kind, what, usd: 0, network: s.req.chain.key, tx, payer: s.from, of: id, status, reported });
  }

  /** The timeout error for `host`, saying whether a payment was signed and until when it can be executed. */
  private timeoutError(host: string, signed?: { validBefore?: number } | null) {
    const after = signed ? ` A payment had been signed and sent. It stays counted${signed.validBefore ? ` and can only be executed until ${new Date(signed.validBefore * 1000).toLocaleTimeString()}` : ""}; check with \`wafermap history --verify\`.` : " Nothing was paid.";
    return new WafermapError("timeout", `${host} did not answer within ${Math.round(this.timeoutMs / 1000)} s.${after}`);
  }

  /** Read a JSON body; a time-out while reading is reported, anything else gives `fallback`. */
  private async body<T>(res: Response, read: () => Promise<T>, fallback: T, host: string, signed?: { validBefore?: number } | null): Promise<T> {
    try {
      return await read();
    } catch (e) {
      if (timedOut(e)) throw this.timeoutError(host, signed);
      return fallback;
    }
  }

  // Check-sign-book runs one payment at a time in this process, so two calls started together
  // cannot both pass the daily cap on the same remaining budget. Across processes, see onSigned.
  private queue: Promise<void> = Promise.resolve();
  private acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const prev = this.queue;
    this.queue = prev.then(() => held);
    return prev.then(() => release);
  }

  private async paidFetch(kind: "resource" | "service", what: string, url: string, init: RequestInit, network?: Net) {
    let id: string | null = null;
    let release: (() => void) | null = null;
    const unlock = () => {
      release?.();
      release = null;
    };
    try {
      const r = await x402fetch(url, init, {
        signer: this.account as any,
        solana: this.solana ?? undefined,
        prefer: this.prefer(network),
        fetch: this.fetch,
        approve: async (req) => {
          release = await this.acquire();
          await this.gate({ kind, what, usd: req.usd, network: req.chain.key, detail: `${req.chain.symbol} to ${req.payTo}` });
        },
        onSigned: (s) => {
          id = this.booked(kind, what, s);
          unlock();
          // The queue serialises this process only. Another process using the same ledger (a second
          // MCP client, or the CLI next to the MCP server) may have booked since our check. Re-read
          // the shared total now that ours is in it: if the cap is passed, the signed payment is
          // dropped here, never sent, and its booking reversed. Two racing processes can both drop;
          // neither can both send.
          if (this.spentToday() > this.limits.perDay + 1e-9) {
            this.ledger.record({ at: Date.now(), kind, what, usd: -s.req.usd, network: s.req.chain.key, tx: null, payer: s.from, of: id, status: "aborted" });
            id = null;
            throw new WafermapError("over_daily_cap", `Another payment from this wallet used the daily cap of $${this.limits.perDay} at the same time. Nothing was sent.`);
          }
        },
      });
      return { ...r, id: id as string | null };
    } catch (e: any) {
      // Signed but no answer: the payment stays counted (status "signed"); nothing more to write.
      if (e instanceof WafermapError) throw e;
      if (e instanceof X402Error) throw new WafermapError(e.code, e.message);
      if (timedOut(e)) throw this.timeoutError(new URL(url).host, id ? (this.ledger.entries().find((x) => x.id === id) ?? {}) : null);
      throw new WafermapError("network_error", `${new URL(url).host}: ${e?.cause?.message ?? e?.message ?? "request failed"}`);
    } finally {
      unlock();
    }
  }

  // ---- Wafermap resources ----

  async resources(): Promise<any[]> {
    const host = new URL(this.baseUrl).host;
    const r = await this.fetch(`${this.baseUrl}/v1/resources`).catch((e) => {
      throw timedOut(e) ? this.timeoutError(host) : new WafermapError("network_error", `${host}: ${e?.message ?? "request failed"}`);
    });
    const j: any = await this.body(r, () => r.json(), null, host);
    return j?.data ?? [];
  }

  async call(id: string, input: Record<string, unknown> = {}, o: { network?: Net } = {}) {
    // X-Wafermap-Payer names this wallet so a $WAFERMAP holder is quoted the holder price (only sent to Wafermap,
    // never to third-party services; the server checks the balance again against the signed payment).
    const go = () => this.paidFetch("resource", id, `${this.baseUrl}/v1/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-wafermap-payer": this.address }, body: JSON.stringify(input) }, o.network);
    const settle = (r: Awaited<ReturnType<typeof go>>, out: any) => {
      if (!r.paid || !r.id) return;
      const status: PaymentStatus = r.res.status === 402 ? "refused" : r.res.ok ? "ok" : "failed";
      this.outcome(r.id, "resource", id, r.paid, status, out?.receipt?.tx ?? r.paid.tx, typeof out?.receipt?.amountUsd === "number" ? out.receipt.amountUsd : null);
    };
    const host = new URL(this.baseUrl).host;
    const read = (r: Awaited<ReturnType<typeof go>>) => this.body(r.res, () => r.res.json(), {} as any, host, r.paid?.auth ?? (r.paid ? {} : null));
    let r = await go();
    let out: any = await read(r);
    settle(r, out);
    // The facilitator rotates its Solana fee payers; a quote that named one just rotated out is
    // refused before anything moves. Ask for a fresh quote once. (The refused one stays counted.)
    if (r.paid?.req.chain.vm === "svm" && r.res.status === 402 && /fee_payer/i.test(JSON.stringify(out))) {
      r = await go().catch((e) => {
        if (e?.code === "over_daily_cap") throw new WafermapError("over_daily_cap", `The facilitator refused the first Solana payment (its fee payer rotated). That signed payment still counts until it expires, and a second one would pass the daily cap of $${this.limits.perDay}. Try again in a few minutes or pay on another network.`);
        throw e;
      });
      out = await read(r);
      settle(r, out);
    }
    const { res, paid } = r;
    const refused = this.rejected(res, out, paid);
    if (refused) throw refused;
    if (!res.ok) throw new WafermapError(out?.error?.code ?? "http_error", out?.error?.message ?? (typeof out?.error === "string" ? out.error : `HTTP ${res.status}`));
    return out as { resource: string; result: any; receipt: { network: string; asset: string; amountUsd: number; payer: string; tx: string; ms: number } | null };
  }

  // ---- Third-party x402 services ----

  async discover(query: string, limit = 10) {
    const host = new URL(this.baseUrl).host;
    const r = await this.fetch(`${this.baseUrl}/api/discover?q=${encodeURIComponent(query)}&limit=${limit}`).catch((e) => {
      throw timedOut(e) ? this.timeoutError(host) : new WafermapError("network_error", `${host}: ${e?.message ?? "request failed"}`);
    });
    const j: any = await this.body(r, () => r.json(), null, host);
    if (!r.ok || !Array.isArray(j?.services)) throw new WafermapError(j?.error?.code ?? "discovery_failed", j?.error?.message ?? "Discovery is unavailable.");
    return j.services as { url: string; method: string; name: string | null; description: string; priceUsd: number | null; networks: string[]; payable: boolean; input: unknown; outputExample: unknown }[];
  }

  /** Call any x402 URL and pay it if it asks. GET sends `input` as the query string, POST as JSON. */
  async pay(url: string, o: { method?: "GET" | "POST"; input?: Record<string, unknown>; network?: Net } = {}) {
    const method = o.method ?? "GET";
    const qs = method === "GET" && o.input && Object.keys(o.input).length ? new URLSearchParams(Object.entries(o.input).map(([k, v]) => [k, String(v)])).toString() : "";
    const target = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
    const init: RequestInit = method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(o.input ?? {}) };
    const u = new URL(url);
    const what = `${u.host}${u.pathname}`;
    const { res, paid, id } = await this.paidFetch("service", what, target, init, o.network);
    if (paid && id) this.outcome(id, "service", what, paid, res.status === 402 ? "refused" : res.ok ? "ok" : "failed", paid.tx);
    const type = res.headers.get("content-type") ?? "";
    const signed = paid?.auth ?? (paid ? {} : null);
    const result = /json/.test(type) ? await this.body(res, () => res.json(), null, u.host, signed) : /^(image|audio|video)\//.test(type) ? { bytes: (await this.body(res, () => res.arrayBuffer(), new ArrayBuffer(0), u.host, signed)).byteLength, contentType: type } : await this.body(res, () => res.text(), "", u.host, signed);
    const refused = this.rejected(res, result, paid);
    if (refused) throw refused;
    if (!res.ok) throw new WafermapError(paid ? "payment_failed" : "http_error", `${u.host} answered ${res.status}: ${JSON.stringify(result).slice(0, 300)}`);
    return { status: res.status, result, paid: paid ? { usd: paid.req.usd, network: paid.req.chain.key, tx: paid.tx } : null };
  }

  // ---- Wallet ----

  async balances() {
    const out = Object.fromEntries(NETS.map((n) => [n, null])) as Record<Net, { eth: string; gas: string; stable: string; symbol: string } | null>;
    const sol = this.solanaAddress;
    await Promise.all([
      sol
        ? solanaBalances(this.rpc.solana ?? `${this.baseUrl}/api/solana`, sol, this.fetch).then(
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
      const j: any = await this.fetch(`${this.baseUrl}/api/tokens?network=${n}`)
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
      return await quoteSwap({ network: n, tokenIn, tokenOut, amount, fetch: this.fetch });
    } catch (e: any) {
      throw new WafermapError(e?.code ?? "quote_failed", e?.shortMessage ?? e?.message ?? "No quote.");
    }
  }

  async swap(quote: SwapQuote, o: { slippageBps?: number; step?: (s: string) => void } = {}) {
    if (!quote.amountInUsd) throw new WafermapError("no_usd_value", "This swap has no USD value, so the per-swap cap cannot be checked. Not sent.");
    await this.gate({ kind: "swap", what: `${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, usd: quote.amountInUsd, network: quote.network, detail: `about ${quote.amountOut} ${quote.tokenOut.symbol}` });
    const wallet = createWalletClient({ account: this.account, chain: CHAINS[quote.network], transport: http(this.rpc[quote.network]) });
    try {
      const r = await executeSwap({ quote, wallet: wallet as any, client: this.client(quote.network) as any, slippageBps: o.slippageBps, step: o.step, fetch: this.fetch });
      this.ledger.record({ at: Date.now(), kind: "swap", what: `${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.tokenOut.symbol}`, usd: 0, network: quote.network, tx: r.tx, payer: this.address });
      return r;
    } catch (e: any) {
      throw new WafermapError(e?.code ?? "swap_failed", e?.shortMessage ?? e?.message ?? "Swap failed.");
    }
  }
}

export type { SwapQuote, Token };
