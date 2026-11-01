import { SOLANA_CAIP, SOLANA_USDC, solanaPayment, type SolanaPayer } from "./solana";

// A small x402 buyer used by the web app, the CLI, the SDK and the MCP server.
// It pays any x402 endpoint (Wafermap's own /v1 or a third-party service found through
// discovery) that accepts the `exact` scheme in a USD stablecoin we know on an EVM chain
// (USDG on Robinhood Chain; USDC on Base, Arbitrum, Polygon) or USDC on Solana, so every price
// can be checked against the user's caps in dollars. Solana is paid only when the caller passes
// a Solana payer (see ./solana).
// Both protocol versions are handled: v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers)
// and v1 (402 JSON body / X-PAYMENT header).

export type Hex = `0x${string}`;

/** Anything that can sign EIP-712 typed data for one address (a viem account works). */
export type Signer = {
  address: Hex;
  signTypedData: (args: { domain: any; types: any; primaryType: string; message: any }) => Promise<Hex>;
};

export type ChainKey = "robinhood" | "base" | "arbitrum" | "polygon" | "solana";
export type Chain = { key: ChainKey; vm: "evm" | "svm"; id: number; caip: string; v1: string; stable: string; symbol: string; name: string; domain?: { name: string; version: string } };

const USDC_DOMAIN = { name: "USD Coin", version: "2" };
export const PAY_CHAINS: Chain[] = [
  { key: "robinhood", vm: "evm", id: 4663, caip: "eip155:4663", v1: "robinhood", stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "Robinhood Chain", domain: { name: "Global Dollar", version: "1" } },
  { key: "solana", vm: "svm", id: 0, caip: SOLANA_CAIP, v1: "solana", stable: SOLANA_USDC, symbol: "USDC", name: "Solana" },
  { key: "base", vm: "evm", id: 8453, caip: "eip155:8453", v1: "base", stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "Base", domain: USDC_DOMAIN },
  { key: "arbitrum", vm: "evm", id: 42161, caip: "eip155:42161", v1: "arbitrum", stable: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", name: "Arbitrum", domain: USDC_DOMAIN },
  { key: "polygon", vm: "evm", id: 137, caip: "eip155:137", v1: "polygon", stable: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", name: "Polygon", domain: USDC_DOMAIN },
];
export const EVM_CHAINS = PAY_CHAINS.filter((c) => c.vm === "evm");
export const CHAIN_KEYS = PAY_CHAINS.map((c) => c.key);

export type Requirement = {
  version: 1 | 2;
  chain: Chain;
  /** Base units, 6 decimals. */
  amount: string;
  usd: number;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  /** EVM: the token's EIP-712 domain. Solana: the facilitator's fee payer and an optional memo. */
  extra: { name?: string; version?: string; feePayer?: string; memo?: string };
  /** The requirement exactly as the server sent it (echoed back in the payment). */
  raw: any;
};

export type Quote = { version: 1 | 2; resource: any; accepts: Requirement[]; offered: string[]; inputError?: { code: string; message: string } };

export class X402Error extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// UTF-8 safe base64 with globals that exist in browsers, Workers and Node 18+.
const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

function chainOf(network: unknown): Chain | undefined {
  const n = String(network ?? "").toLowerCase();
  return PAY_CHAINS.find((c) => c.caip.toLowerCase() === n || c.v1 === n || (c.id > 0 && String(c.id) === n));
}

/** Read a 402 response into a quote. Only payable requirements are kept in `accepts`. */
export async function readQuote(res: Response): Promise<Quote> {
  let body: any = null;
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      body = JSON.parse(b64decode(header));
    } catch {
      /* fall back to the body */
    }
  }
  if (!body) body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.accepts)) throw new X402Error("not_x402", "The service answered 402 without x402 payment details.");
  const version: 1 | 2 = Number(body.x402Version) === 1 ? 1 : 2;
  const accepts: Requirement[] = [];
  const offered: string[] = [];
  for (const r of body.accepts) {
    offered.push(`${r.scheme ?? "?"}/${r.network ?? "?"}`);
    const chain = chainOf(r.network);
    if (!chain || r.scheme !== "exact") continue;
    if (chain.vm === "evm" ? String(r.asset ?? "").toLowerCase() !== chain.stable.toLowerCase() : r.asset !== chain.stable) continue;
    const amount = String(version === 1 ? r.maxAmountRequired : r.amount);
    if (!/^\d+$/.test(amount)) continue;
    let extra: Requirement["extra"];
    if (chain.vm === "svm") {
      if (typeof r.extra?.feePayer !== "string") continue;
      extra = { feePayer: r.extra.feePayer, ...(typeof r.extra.memo === "string" ? { memo: r.extra.memo } : {}) };
    } else extra = r.extra?.name && r.extra?.version ? { name: String(r.extra.name), version: String(r.extra.version) } : chain.domain!;
    accepts.push({ version, chain, amount, usd: Number(amount) / 1e6, payTo: r.payTo, asset: r.asset, maxTimeoutSeconds: Number(r.maxTimeoutSeconds) || 120, extra, raw: r });
  }
  const inputError = body.inputError?.message ? { code: String(body.inputError.code ?? "invalid_input"), message: String(body.inputError.message) } : undefined;
  return { version, resource: body.resource ?? null, accepts, offered, inputError };
}

/** Pick the requirement to pay: the first preferred chain that is offered. */
export function choose(q: Quote, prefer: ChainKey[] = CHAIN_KEYS): Requirement {
  for (const k of prefer) {
    const r = q.accepts.find((a) => a.chain.key === k);
    if (r) return r;
  }
  throw new X402Error("no_supported_payment", q.offered.length ? `This service only accepts ${[...new Set(q.offered)].join(", ")}. Wafermap pays USDG on Robinhood Chain or USDC on Solana, Base, Arbitrum or Polygon.` : "The service offered no payment option.");
}

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const randomNonce = (): Hex => ("0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;

/** Sign the payment for the exact amount and return the header to send: an EIP-3009 transfer on
 *  EVM chains, a partially signed USDC transfer transaction on Solana. */
export async function signPayment(signer: Signer, req: Requirement, resource: any, solana?: SolanaPayer): Promise<{ name: string; value: string; auth?: SignedAuth }> {
  if (req.chain.vm === "svm") {
    if (!solana) throw new X402Error("no_solana_wallet", "This payment is on Solana and no Solana wallet was given.");
    let transaction: string;
    try {
      transaction = await solanaPayment(solana, { amount: req.amount, payTo: req.payTo, asset: req.asset, feePayer: req.extra.feePayer!, memo: req.extra.memo });
    } catch (e: any) {
      throw new X402Error("sign_failed", e?.message ?? "Could not build the Solana payment.");
    }
    if (req.version === 1) return { name: "X-PAYMENT", value: b64encode(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.raw.network, payload: { transaction } })) };
    return { name: "PAYMENT-SIGNATURE", value: b64encode(JSON.stringify({ x402Version: 2, resource, accepted: req.raw, payload: { transaction } })) };
  }
  const nonce = randomNonce();
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds, 300));
  const message = { from: signer.address, to: req.payTo, value: BigInt(req.amount), validAfter: 0n, validBefore, nonce };
  let signature: Hex;
  try {
    signature = await signer.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: req.chain.id, verifyingContract: req.asset as Hex }, types: TYPES, primaryType: "TransferWithAuthorization", message });
  } catch (e: any) {
    throw new X402Error("sign_rejected", e?.shortMessage ?? e?.message ?? "Signature rejected.");
  }
  const authorization = { from: signer.address, to: req.payTo, value: req.amount, validAfter: "0", validBefore: validBefore.toString(), nonce };
  const auth = { nonce, validBefore: Number(validBefore) };
  if (req.version === 1) return { name: "X-PAYMENT", value: b64encode(JSON.stringify({ x402Version: 1, scheme: "exact", network: req.raw.network, payload: { signature, authorization } })), auth };
  return { name: "PAYMENT-SIGNATURE", value: b64encode(JSON.stringify({ x402Version: 2, resource, accepted: req.raw, payload: { signature, authorization } })), auth };
}

/** Settlement details a server returns after a paid call, when it sends them. */
export function readSettlement(res: Response): { tx?: string; network?: string; success?: boolean } | null {
  const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!h) return null;
  try {
    const j = JSON.parse(b64decode(h));
    return { tx: j.transaction ?? j.txHash ?? j.tx, network: j.network, success: j.success };
  } catch {
    return null;
  }
}

/** What an EVM payment authorized on-chain: anyone holding it can execute it until `validBefore`
 *  (unix seconds), once. `authorizationState(from, nonce)` on the token says whether it was used. */
export type SignedAuth = { nonce: Hex; validBefore: number };
export type Signed = { req: Requirement; from: string; auth?: SignedAuth };
export type PaidCall = { res: Response; paid: (Signed & { tx: string | null }) | null };

/**
 * Fetch an x402 resource, paying once when it answers 402.
 * `approve` sees the chosen requirement before anything is signed; throw to stop.
 * `onSigned` runs once the payment is signed and before it is sent: from then on the payment
 * can be executed whatever the server answers (or if it never answers), so a spend limit has to
 * count it here, at its full amount, not from what the server reports back.
 */
export async function x402fetch(
  url: string,
  init: RequestInit,
  opts: { signer: Signer | (() => Promise<Signer>); solana?: SolanaPayer; prefer?: ChainKey[]; approve?: (req: Requirement) => Promise<void> | void; onSigned?: (s: Signed) => void; fetch?: typeof fetch },
): Promise<PaidCall> {
  const f = opts.fetch ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { res: first, paid: null };
  const quote = await readQuote(first);
  // Some servers (Wafermap among them) quote even when the input is wrong; never sign for that.
  if (quote.inputError) throw new X402Error(quote.inputError.code, quote.inputError.message);
  const req = choose(quote, (opts.prefer ?? CHAIN_KEYS).filter((k) => k !== "solana" || opts.solana));
  if (opts.approve) await opts.approve(req);
  const svm = req.chain.vm === "svm";
  const signer = svm ? null : typeof opts.signer === "function" ? await opts.signer() : opts.signer;
  const header = await signPayment(signer!, req, quote.resource, opts.solana);
  const signed: Signed = { req, from: svm ? opts.solana!.address : signer!.address, ...(header.auth ? { auth: header.auth } : {}) };
  opts.onSigned?.(signed);
  const headers = new Headers(init.headers);
  headers.set(header.name, header.value);
  const res = await f(url, { ...init, headers });
  return { res, paid: { ...signed, tx: readSettlement(res)?.tx ?? null } };
}
