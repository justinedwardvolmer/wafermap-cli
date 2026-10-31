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

/** Signs as one Solana address. `blockhash` returns a recent blockhash from any mainnet RPC. */
export type SolanaPayer = { address: string; sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>; blockhash: () => Promise<string> };

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
  const message = concat(
    Uint8Array.of(0x80, 2, 1, 4), // v0; 2 signatures, 1 of them readonly; 4 readonly non-signers
    shortvec(keys.length),
    ...keys.map((k) => base58.decode(k)),
    base58.decode(await payer.blockhash()),
    shortvec(ixs.length),
    ...ixs.map((ix) => concat(Uint8Array.of(at(ix.program)), shortvec(ix.accounts.length), Uint8Array.from(ix.accounts.map(at)), shortvec(ix.data.length), ix.data)),
    shortvec(0), // no address lookup tables
  );
  const signature = await payer.sign(message);
  return base64.encode(concat(shortvec(2), new Uint8Array(64), signature, message));
}

// ---- Reads, through any Solana JSON-RPC endpoint (Wafermap serves one at /api/solana) ----

export async function solanaRpc(url: string, method: string, params: unknown[], f: typeof fetch = fetch): Promise<any> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json().catch(() => null);
  if (!j) throw new Error(`Solana RPC answered ${r.status}.`);
  if (j.error) throw new Error(j.error.message ?? "Solana RPC error.");
  return j.result;
}

export const latestBlockhash = async (url: string, f?: typeof fetch): Promise<string> => (await solanaRpc(url, "getLatestBlockhash", [{ commitment: "confirmed" }], f)).value.blockhash;

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
