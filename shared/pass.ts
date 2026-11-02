// Holder pass: a signed message (personal_sign, no transaction) that proves a client controls a wallet, so
// Wafermap can grant what that wallet's $WAFERMAP holding unlocks: free calls, x402 Tracker Pro. Sent as the
// X-Wafermap-Pass header, base64url JSON {v, address, iat, exp, sig}. Valid for at most PASS_MAX_SECONDS.
// The server rebuilds the message from the fields, so a client cannot change any line. Shared by the worker,
// the web wallet and the CLI.
export const PASS_HEADER = "x-wafermap-pass";
export const PASS_MAX_SECONDS = 86_400;

export type Pass = { v: 1; address: string; iat: number; exp: number; sig: string };

/** The exact text the wallet signs. */
export function passMessage(address: string, iat: number, exp: number): string {
  return [
    "wafermap.xyz holder pass",
    "",
    `Wallet: ${address}`,
    `Issued: ${new Date(iat * 1000).toISOString()}`,
    `Expires: ${new Date(exp * 1000).toISOString()}`,
    "",
    "Proves you hold this wallet, so Wafermap can apply what your $WAFERMAP unlocks. It costs nothing and moves no funds.",
  ].join("\n");
}

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export const encodePass = (p: Pass) => b64url(JSON.stringify(p));

/** The pass's fields, or null when it is not a well-formed pass (the signature is not checked here). */
export function decodePass(s: string | undefined | null): Pass | null {
  if (!s || s.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const p = JSON.parse(unb64url(s));
    if (p?.v !== 1 || typeof p.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.address)) return null;
    if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || typeof p.sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(p.sig)) return null;
    return { v: 1, address: p.address, iat: p.iat, exp: p.exp, sig: p.sig };
  } catch {
    return null;
  }
}

/** Signs a new pass with any signer that can personal_sign. Valid for `seconds` (at most a day). */
export async function makePass(signer: { address: string; signMessage: (a: { message: string }) => Promise<string> }, seconds = PASS_MAX_SECONDS, now = Math.floor(Date.now() / 1000)): Promise<Pass> {
  const iat = now;
  const exp = now + Math.min(Math.max(60, seconds), PASS_MAX_SECONDS);
  const sig = await signer.signMessage({ message: passMessage(signer.address, iat, exp) });
  return { v: 1, address: signer.address, iat, exp, sig };
}
