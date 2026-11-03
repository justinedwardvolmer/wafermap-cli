// The Solana side of the Wafermap wallet.
//  - The key: derived from the agent's EVM private key (HMAC-SHA256 under a fixed label), so the
//    one backup the user already has covers both chains. It exports in the base58 64-byte form
//    Phantom and Solflare import.
//  - The payment: x402 `exact` on Solana. A v0 transaction with SetComputeUnitLimit,
//    SetComputeUnitPrice, a USDC TransferChecked and a Memo nonce, whose fee payer is the
//    facilitator. We sign as the transfer authority and leave the fee payer's signature empty;
//    the facilitator checks the layout, adds its signature and submits.
// Built by hand on @noble/@scure (already under viem) instead of pulling in a Solana SDK: the
// layout is small and fixed, and the same code runs in the browser, Workers and Node.
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64 } from "@scure/base";

export const SOLANA_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
// The x402 reference client's values; facilitators cap the price at 5 lamports per CU.
const CU_LIMIT = 20_000;
const CU_PRICE_MICROLAMPORTS = 1n;
const MAX_MEMO_BYTES = 256;

/** Signs as one Solana address. `blockhash` returns a recent blockhash from any mainnet RPC. When
 *  `blockhashInfo` is given it is used instead, and the slot the blockhash was read at is kept with
 *  the payment: the payment cannot land before it, which bounds the search for it later. */
export type SolanaPayer = {
  address: string;
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  blockhash: () => Promise<string>;
  blockhashInfo?: () => Promise<{ blockhash: string; slot: number }>;
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};
const hexBytes = (h: string) => {
  const s = h.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("Expected a 32-byte hex private key.");
  return Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));
};
const le = (v: bigint, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
/** Solana's compact-u16 length prefix. */
const shortvec = (n: number) => {
  const out: number[] = [];
  for (let v = n; ; ) {
    const b = v & 0x7f;
    v >>= 7;
    if (!v) return Uint8Array.from([...out, b]);
    out.push(b | 0x80);
  }
};

export function isSolanaAddress(v: string): boolean {
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
}

/** The agent's Solana keypair, derived from its EVM private key. */
export function solanaKeyFromEvm(privateKey: string) {
  const seed = hmac(sha256, hexBytes(privateKey), utf8("wafermap/solana/v1"));
  const pub = ed25519.getPublicKey(seed);
  return {
    address: base58.encode(pub),
    /** seed ‖ public key, base58: the format Phantom and Solflare import. */
    secretKey: base58.encode(concat(seed, pub)),
    sign: (message: Uint8Array) => ed25519.sign(message, seed),
  };
}

const onCurve = (b: Uint8Array) => {
  try {
    ed25519.ExtendedPoint.fromHex(b);
    return true;
  } catch {
    return false;
  }
};

/** The associated token account of `owner` for `mint` (classic SPL Token program). */
export function ataOf(owner: string, mint = SOLANA_USDC): string {
  const seeds = concat(base58.decode(owner), base58.decode(TOKEN_PROGRAM), base58.decode(mint));
  const tail = concat(base58.decode(ATA_PROGRAM), utf8("ProgramDerivedAddress"));
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(seeds, Uint8Array.of(bump), tail));
    if (!onCurve(h)) return base58.encode(h);
  }
  throw new Error("No associated token account address.");
}

export type SolanaQuote = { amount: string; payTo: string; asset: string; feePayer: string; memo?: string };

/** The base64 wire transaction for an x402 `exact` payment on Solana, signed by `payer` only. */
export async function solanaPayment(payer: SolanaPayer, q: SolanaQuote): Promise<string> {
  return (await solanaPaymentSigned(payer, q)).transaction;
}

/** What a signed Solana payment leaves to check it by later: our signature (the second one in the
 *  transaction; the first, which names it on explorers, is the facilitator's and unknown until it
 *  submits), its memo, its blockhash (once that is no longer valid the payment can never execute)
 *  and, when known, the slot the blockhash was read at. */
export type SolanaSigned = { transaction: string; signature: string; memo: string; blockhash: string; slot?: number };

export async function solanaPaymentSigned(payer: SolanaPayer, q: SolanaQuote): Promise<SolanaSigned> {
  if (q.asset !== SOLANA_USDC) throw new Error("Only USDC is paid on Solana.");
  if (!isSolanaAddress(q.feePayer) || !isSolanaAddress(q.payTo)) throw new Error("The quote has no valid Solana fee payer or recipient.");
  if (q.feePayer === payer.address) throw new Error("The fee payer cannot be the paying wallet.");
  const memo = utf8(q.memo ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  if (memo.length > MAX_MEMO_BYTES) throw new Error("The seller's memo is too long.");
  const source = ataOf(payer.address, q.asset);
  const dest = ataOf(q.payTo, q.asset);

  // Accounts in Solana's order: writable signer (fee payer), readonly signer (us), writable
  // non-signers (both token accounts), readonly non-signers (mint and the three programs).
  const keys = [q.feePayer, payer.address, source, dest, q.asset, TOKEN_PROGRAM, COMPUTE_BUDGET, MEMO_PROGRAM];
  if (new Set(keys).size !== keys.length) throw new Error("The quote reuses an account it should not.");
  const at = (k: string) => keys.indexOf(k);
  const ixs: { program: string; accounts: string[]; data: Uint8Array }[] = [
    { program: COMPUTE_BUDGET, accounts: [], data: concat(Uint8Array.of(2), le(BigInt(CU_LIMIT), 4)) },
    { program: COMPUTE_BUDGET, accounts: [], data: concat(Uint8Array.of(3), le(CU_PRICE_MICROLAMPORTS, 8)) },
    { program: TOKEN_PROGRAM, accounts: [source, q.asset, dest, payer.address], data: concat(Uint8Array.of(12), le(BigInt(q.amount), 8), Uint8Array.of(USDC_DECIMALS)) },
    { program: MEMO_PROGRAM, accounts: [], data: memo },
  ];
  const bh = payer.blockhashInfo ? await payer.blockhashInfo() : { blockhash: await payer.blockhash() };
  const message = concat(
    Uint8Array.of(0x80, 2, 1, 4), // v0; 2 signatures, 1 of them readonly; 4 readonly non-signers
    shortvec(keys.length),
    ...keys.map((k) => base58.decode(k)),
    base58.decode(bh.blockhash),
    shortvec(ixs.length),
    ...ixs.map((ix) => concat(Uint8Array.of(at(ix.program)), shortvec(ix.accounts.length), Uint8Array.from(ix.accounts.map(at)), shortvec(ix.data.length), ix.data)),
    shortvec(0), // no address lookup tables
  );
  const signature = await payer.sign(message);
  return {
    transaction: base64.encode(concat(shortvec(2), new Uint8Array(64), signature, message)),
    signature: base58.encode(signature),
    memo: new TextDecoder().decode(memo),
    blockhash: bh.blockhash,
    ...("slot" in bh && Number.isFinite(bh.slot) ? { slot: bh.slot } : {}),
  };
}

// ---- Reads, through any Solana JSON-RPC endpoint (Wafermap serves one at /api/solana) ----

export async function solanaRpc(url: string, method: string, params: unknown[], f: typeof fetch = fetch): Promise<any> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json().catch(() => null);
  if (!j) throw new Error(`Solana RPC answered ${r.status}.`);
  if (j.error) throw new Error(j.error.message ?? "Solana RPC error.");
  return j.result;
}

export const latestBlockhash = async (url: string, f?: typeof fetch): Promise<string> => (await latestBlockhashInfo(url, f)).blockhash;
export const latestBlockhashInfo = async (url: string, f?: typeof fetch): Promise<{ blockhash: string; slot: number }> => {
  const r = await solanaRpc(url, "getLatestBlockhash", [{ commitment: "confirmed" }], f);
  return { blockhash: r.value.blockhash, slot: Number(r.context?.slot) };
};

/** The public Solana RPC that `checkSolanaPayment` reads by default: not Wafermap's, so the answer
 *  does not depend on the server that was paid. */
export const SOLANA_PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

const READ_TIMEOUT_MS = 15_000;

/** A Solana RPC read with a time limit, retried with growing waits when a free endpoint rate-limits. */
async function solanaRead(url: string, method: string, params: unknown[], f: typeof fetch = fetch): Promise<any> {
  const timed: typeof fetch = (input, init) => f(input, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  for (let attempt = 0; ; attempt++) {
    try {
      return await solanaRpc(url, method, params, timed);
    } catch (e: any) {
      if (attempt >= 6 || !/429|rate|too many/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt * (0.75 + Math.random() / 2)));
    }
  }
}

export type SolanaCheck = { payer: string; usd?: number; tx?: string | null; sig?: string; memo?: string; blockhash?: string; slot?: number };

/** Did this transaction carry our payment, and did it succeed? null: the RPC does not have it. */
async function txOutcome(url: string, tx: string, e: SolanaCheck, f?: typeof fetch): Promise<"ok" | "failed" | "other" | null> {
  const t = await solanaRead(url, "getTransaction", [tx, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], f);
  if (!t) return null;
  const sigs: string[] = t.transaction?.signatures ?? [];
  const keys: string[] = t.transaction?.message?.accountKeys ?? [];
  // With our signature on record, it must be in this transaction. Without it (payments logged
  // before 0.4.7), the wallet must be its second signer and its USDC must have gone down by the
  // amount it signed for.
  if (e.sig ? !sigs.includes(e.sig) : keys[1] !== e.payer) return "other";
  if (t.meta?.err) return "failed";
  if (!e.sig) {
    const bal = (list: any[]) => BigInt(list?.find((b) => b.owner === e.payer && b.mint === SOLANA_USDC)?.uiTokenAmount?.amount ?? "0");
    const drop = bal(t.meta?.preTokenBalances) - bal(t.meta?.postTokenBalances);
    if (drop <= 0n || (e.usd !== undefined && drop !== BigInt(Math.round(e.usd * 1e6)))) return "other";
  }
  return "ok";
}

/** A blockhash can be used until the chain is this many blocks past the block it names. */
const BLOCKHASH_MAX_AGE = 150;

/**
 * Was a signed Solana payment ever executed? Read from a Solana RPC (by default the public one, not
 * Wafermap's), and every number it rests on is checked on that RPC, not taken from the server
 * that was paid.
 *  - The transaction the server named, if it carries our signature: "used" when it succeeded.
 *  - Otherwise the payment is anchored to the block its blockhash names: the block at the logged
 *    slot must have exactly that hash. The payment can only land after that slot, and only until
 *    the chain is BLOCKHASH_MAX_AGE blocks past it. Then, with the finalized height H at slot S:
 *    the wallet's USDC account history, read from a node at slot S or later, back to that slot,
 *    is searched for our signature. Found: "used" (or "unused" if it landed and failed: nothing
 *    moved, and it cannot land again). Not found: "unused" when H is past the last valid height
 *    (any landing would then be final and in that history), else "pending".
 *  - Anything that cannot be established that way throws (the CLI shows "error"); it is never
 *    "unused". Lines from before 0.4.7 have no signature: only the server's transaction can prove
 *    them ("used"), else "unknown".
 */
export async function checkSolanaPayment(e: SolanaCheck, url = SOLANA_PUBLIC_RPC, f?: typeof fetch): Promise<"used" | "unused" | "pending" | "unknown"> {
  if (e.tx) {
    // A malformed or unknown id from the server is no answer either way: fall through to the search.
    const o = await txOutcome(url, e.tx, e, f).catch(() => null);
    if (o === "ok") return "used";
    if (o === "failed" && e.sig) return "unused";
  }
  if (!e.sig || !e.blockhash || !Number.isSafeInteger(e.slot) || e.slot! <= 0) return "unknown";
  const slot = e.slot!;

  const block = await solanaRead(url, "getBlock", [slot, { commitment: "confirmed", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }], f);
  if (!block || block.blockhash !== e.blockhash || !Number.isSafeInteger(block.blockHeight)) throw new Error("The chain has no block with this payment's blockhash at the logged slot.");
  const lastValidHeight = block.blockHeight + BLOCKHASH_MAX_AGE;

  const fin = await solanaRead(url, "getEpochInfo", [{ commitment: "finalized" }], f);
  const S = Number(fin?.absoluteSlot);
  const H = Number(fin?.blockHeight);
  if (!Number.isSafeInteger(S) || !Number.isSafeInteger(H)) throw new Error("The RPC did not give the finalized height.");
  const expired = H > lastValidHeight;

  let before: string | undefined;
  let reached = false;
  search: for (let page = 0; page < 20; page++) {
    const list: any[] = await solanaRead(url, "getSignaturesForAddress", [ataOf(e.payer), { limit: 1000, commitment: "confirmed", minContextSlot: S, ...(before ? { before } : {}) }], f);
    if (!Array.isArray(list)) throw new Error("The RPC did not return the wallet's history.");
    for (const x of list) {
      if (!Number.isSafeInteger(x.slot)) throw new Error("The RPC returned history without slots.");
      if (x.slot <= slot) {
        reached = true; // the payment cannot be in this block or any earlier one
        break search;
      }
      // A memo that is there and differs rules the entry out; a missing one does not.
      if (e.memo && typeof x.memo === "string" && x.memo && !x.memo.includes(e.memo)) continue;
      const o = await txOutcome(url, x.signature, e, f);
      if (o === "ok") return "used";
      if (o === "failed") return "unused";
      if (o === null) throw new Error("The RPC lists a transaction it cannot return.");
    }
    if (list.length < 1000) break;
    before = list[list.length - 1].signature;
  }
  // The paying account was funded before the payment, so a complete history reaches back past it.
  if (!reached) throw new Error("Could not read the wallet's history back to this payment.");
  return expired ? "unused" : "pending";
}

/** USDC (6 decimals) and SOL balances of a wallet. A wallet that never held USDC has no token
 *  account: 0. Read with getAccountInfo, which free public RPCs serve (getTokenAccountBalance is
 *  an "indexed" call some of them reserve for paid keys). */
export async function solanaBalances(url: string, owner: string, f?: typeof fetch): Promise<{ usdc: string; sol: string }> {
  const [usdc, lamports] = await Promise.all([
    solanaRpc(url, "getAccountInfo", [ataOf(owner), { commitment: "confirmed", encoding: "jsonParsed" }], f).then((r) => String(r.value?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? "0")),
    solanaRpc(url, "getBalance", [owner, { commitment: "confirmed" }], f).then((r) => Number(r.value ?? 0)),
  ]);
  return { usdc, sol: String(lamports / 1e9) };
}
