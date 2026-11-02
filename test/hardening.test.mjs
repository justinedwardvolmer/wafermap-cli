// 0.4.0 hardening, from the second public review: payment authorizations expire sooner, every request
// has a time limit, swaps only ever approve and call KyberSwap's router with the quoted amounts, and
// the MCP password can live in the OS keychain. Run: npm test (after npm run build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, verifyMessage, verifyTypedData } from "viem";
import { Wafermap, WAFERMAP_RELAYERS, decodePass, passMessage, listResources, mergeLog, MAX_VALIDITY_SECONDS, quoteSwap, executeSwap, KYBER_ROUTER } from "../dist/index.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** Quotes $0.05; `quoteHang` never sends the quote, `payHang` takes the payment and never answers. */
async function server({ maxTimeoutSeconds = 60, quoteHang = false, payHang = false } = {}) {
  const payments = [];
  const s = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        if (quoteHang) return;
        const quote = { x402Version: 2, resource: { url: req.url }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "50000", asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds, extra: { name: "USD Coin", version: "2" } }] };
        res.writeHead(402, { "payment-required": b64(quote), "content-type": "application/json" });
        return res.end(JSON.stringify(quote));
      }
      payments.push(unb64(sig));
      if (payHang) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: "r", result: { ok: true } }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${s.address().port}`, payments, close: () => new Promise((r) => (s.closeAllConnections(), s.close(r))) };
}

function wallet(baseUrl, extra = {}) {
  const log = [];
  const wm = new Wafermap({ privateKey: generatePrivateKey(), baseUrl, network: "base", limits: { perPayment: 0.1, perDay: 1 }, ledger: { entries: () => log, record: (e) => void log.push(e) }, ...extra });
  return { wm, log };
}

test(`a signed authorization is valid for at most ${MAX_VALIDITY_SECONDS} s, even when the server allows 300`, async () => {
  const s = await server({ maxTimeoutSeconds: 300 });
  try {
    const { wm } = wallet(s.url);
    const before = Math.floor(Date.now() / 1000);
    await wm.call("r");
    const validBefore = Number(s.payments[0].payload.authorization.validBefore);
    assert.ok(validBefore - before <= MAX_VALIDITY_SECONDS + 1, `valid for ${validBefore - before} s`);
    assert.ok(validBefore - before >= MAX_VALIDITY_SECONDS - 2);
  } finally {
    await s.close();
  }
});

test("a server that takes the payment and never answers: the call gives up at the time limit, the payment stays counted", async () => {
  const s = await server({ payHang: true });
  try {
    const { wm, log } = wallet(s.url, { timeoutMs: 600 });
    const t0 = Date.now();
    await assert.rejects(wm.call("r"), (e) => e.code === "timeout" && /history --verify/.test(e.message));
    assert.ok(Date.now() - t0 < 5000, "gave up in time");
    assert.equal(s.payments.length, 1);
    assert.equal(wm.spentToday(), 0.05);
    assert.equal(mergeLog(log)[0].status, "signed");
  } finally {
    await s.close();
  }
});

test("a server that never sends its quote: the call gives up and nothing is signed", async () => {
  const s = await server({ quoteHang: true });
  try {
    const { wm, log } = wallet(s.url, { timeoutMs: 400 });
    await assert.rejects(wm.pay(`${s.url}/x`), (e) => e.code === "timeout" && /Nothing was paid/.test(e.message));
    assert.equal(s.payments.length, 0);
    assert.equal(log.length, 0);
  } finally {
    await s.close();
  }
});

// ---- swaps ----

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETH = { symbol: "ETH", name: "Ether", address: NATIVE, decimals: 18 };
const USDC = { symbol: "USDC", name: "USD Coin", address: USDC_BASE, decimals: 6 };
const EVIL = "0x000000000000000000000000000000000000bEEF";
const json = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const route = { amountOut: "3000000", amountInUsd: "3", amountOutUsd: "3", gasUsd: "0.01" };

test("quoteSwap: a route naming any router but KyberSwap's is refused", async () => {
  await assert.rejects(quoteSwap({ network: "base", tokenIn: ETH, tokenOut: USDC, amount: "0.001", fetch: json({ data: { routeSummary: route, routerAddress: EVIL } }) }), (e) => e.code === "unexpected_router");
  const ok = await quoteSwap({ network: "base", tokenIn: ETH, tokenOut: USDC, amount: "0.001", fetch: json({ data: { routeSummary: route, routerAddress: KYBER_ROUTER.base.toLowerCase() } }) });
  assert.equal(ok.routerAddress, KYBER_ROUTER.base);
});

/** A wallet and chain client that record what would have been sent or approved. */
function fakeChain(allowance = 0n) {
  const sent = [];
  const approved = [];
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = { account, chain: undefined, sendTransaction: async (tx) => (sent.push(tx), "0x01"), writeContract: async (w) => (approved.push(w), "0x02") };
  const client = { getBalance: async () => 10n ** 18n, readContract: async ({ functionName }) => (functionName === "allowance" ? allowance : 10n ** 30n), waitForTransactionReceipt: async () => ({ status: "success" }) };
  return { sent, approved, wallet, client, me: account.address };
}
const quote = (over = {}) => ({ network: "base", tokenIn: ETH, tokenOut: USDC, amountIn: "0.001", amountOut: "3", amountInUsd: 3, amountOutUsd: 3, gasUsd: 0.01, impactPct: 0, routerAddress: KYBER_ROUTER.base, route, at: Date.now(), ...over });

// MetaAggregationRouterV2 calldata, as KyberSwap's build API returns it.
const DESC = "(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)";
const ROUTER_ABI = parseAbi([`function swap((address callTarget, address approveTarget, bytes targetData, ${DESC} desc, bytes clientData) execution) payable returns (uint256, uint256)`]);
function calldata(me, d = {}) {
  const desc = { srcToken: NATIVE, dstToken: USDC_BASE, srcReceivers: [], srcAmounts: [], feeReceivers: [], feeAmounts: [], dstReceiver: me, amount: 10n ** 15n, minReturnAmount: 2_970_000n, flags: 0n, permit: "0x", ...d };
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: "swap", args: [{ callTarget: EVIL, approveTarget: EVIL, targetData: "0x", desc, clientData: "0x" }] });
}
/** A build response: `api` overrides the JSON fields, `desc` the calldata. */
const built = (me, { api = {}, desc = {} } = {}) => json({ data: { routerAddress: KYBER_ROUTER.base, data: calldata(me, desc), amountIn: "1000000000000000", amountOut: "3000000", transactionValue: "1000000000000000", ...api } });

const cases = [
  ["the build names another router", { api: { routerAddress: EVIL } }, "unexpected_router"],
  ["the calldata is not a router swap", { api: { data: "0x1234" } }, "unexpected_calldata"],
  ["the calldata sends the output to someone else", { desc: { dstReceiver: EVIL } }, "build_mismatch"],
  ["the calldata spends a different amount", { desc: { amount: 2n * 10n ** 15n } }, "build_mismatch"],
  ["the calldata trades another token", { desc: { dstToken: EVIL } }, "build_mismatch"],
  ["the calldata takes a fee", { desc: { feeReceivers: [EVIL], feeAmounts: [1n] } }, "build_mismatch"],
  ["the calldata accepts any output (minimum 0)", { desc: { minReturnAmount: 0n } }, "build_mismatch"],
  ["the build sends more ETH than the quote", { api: { transactionValue: "5000000000000000" } }, "build_mismatch"],
  ["the output fell past the slippage", { api: { amountOut: "2900000" } }, "price_moved"],
];
for (const [name, over, code] of cases) {
  test(`executeSwap: nothing is sent when ${name}`, async () => {
    const c = fakeChain();
    await assert.rejects(executeSwap({ quote: quote(), wallet: c.wallet, client: c.client, slippageBps: 100, fetch: built(c.me, over) }), (e) => e.code === code);
    assert.equal(c.sent.length, 0);
  });
}

test("executeSwap: a quote object with another router is refused before any approval", async () => {
  const c = fakeChain();
  await assert.rejects(executeSwap({ quote: quote({ routerAddress: EVIL, tokenIn: USDC, tokenOut: ETH }), wallet: c.wallet, client: c.client, fetch: built(c.me) }), (e) => e.code === "unexpected_router");
  assert.equal(c.sent.length + c.approved.length, 0);
});

test("executeSwap: an ERC-20 swap whose build fails the checks leaves no approval behind", async () => {
  const c = fakeChain(0n);
  const q = quote({ tokenIn: USDC, tokenOut: ETH, amountIn: "3", amountOut: "0.001" });
  const bad = built(c.me, { api: { amountIn: "3000000", amountOut: "1000000000000000", transactionValue: "0" }, desc: { srcToken: USDC_BASE, dstToken: NATIVE, amount: 3_000_000n, minReturnAmount: 99n * 10n ** 13n, dstReceiver: EVIL } });
  await assert.rejects(executeSwap({ quote: q, wallet: c.wallet, client: c.client, fetch: bad }), (e) => e.code === "build_mismatch");
  assert.equal(c.approved.length, 0);
  assert.equal(c.sent.length, 0);
});

test("executeSwap: a matching build is sent to KyberSwap's router with exactly the quoted ETH", async () => {
  const c = fakeChain();
  const r = await executeSwap({ quote: quote(), wallet: c.wallet, client: c.client, slippageBps: 100, fetch: built(c.me) });
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].to, KYBER_ROUTER.base);
  assert.equal(c.sent[0].value, 10n ** 15n);
  assert.equal(r.amountOutMin, "2.97"); // read from the calldata's minReturnAmount
});

test("executeSwap: an ERC-20 swap approves exactly the amount, to the router, after the checks", async () => {
  const c = fakeChain(0n);
  const q = quote({ tokenIn: USDC, tokenOut: ETH, amountIn: "3", amountOut: "0.001" });
  const ok = built(c.me, { api: { amountIn: "3000000", amountOut: "1000000000000000", transactionValue: "0" }, desc: { srcToken: USDC_BASE, dstToken: NATIVE, amount: 3_000_000n, minReturnAmount: 99n * 10n ** 13n } });
  await executeSwap({ quote: q, wallet: c.wallet, client: c.client, fetch: ok });
  assert.equal(c.approved.length, 1);
  assert.equal(c.approved[0].args[0], KYBER_ROUTER.base);
  assert.equal(c.approved[0].args[1], 3_000_000n);
  assert.equal(c.sent[0].value, 0n);
});

// ---- the MCP password in the OS keychain ----

const CLI = join(process.cwd(), "dist", "cli.js");
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

/** On Linux and macOS the store is replaced by a stub on PATH that keeps the secret in a file. */
function stubStore(dir) {
  if (process.platform === "win32") return {}; // real Windows DPAPI
  const db = join(dir, "secret.txt");
  const name = process.platform === "darwin" ? "security" : "secret-tool";
  const script =
    process.platform === "darwin"
      ? `#!/usr/bin/env node
const fs=require("fs"),a=process.argv.slice(2),db=${JSON.stringify(db)};
if(a[0]==="-i"){const l=fs.readFileSync(0,"utf8");const m=l.match(/-X ([0-9a-f]+)/);fs.writeFileSync(db,Buffer.from(m[1],"hex").toString("utf8"));}
else if(a[0]==="find-generic-password"){if(!fs.existsSync(db))process.exit(44);process.stdout.write(fs.readFileSync(db,"utf8")+"\\n");}
else if(a[0]==="delete-generic-password"){fs.rmSync(db,{force:true});}`
      : `#!/usr/bin/env node
const fs=require("fs"),a=process.argv.slice(2),db=${JSON.stringify(db)};
if(a[0]==="store"){fs.writeFileSync(db,fs.readFileSync(0,"utf8"));}
else if(a[0]==="lookup"){if(!fs.existsSync(db))process.exit(1);process.stdout.write(fs.readFileSync(db,"utf8"));}
else if(a[0]==="clear"){fs.rmSync(db,{force:true});}`;
  writeFileSync(join(dir, name), script);
  chmodSync(join(dir, name), 0o755);
  return { PATH: `${dir}:${process.env.PATH}`, db };
}

test("keychain: the MCP password is stored by the OS, unlocks the wallet, and is never written in plain text", () => {
  const home = mkdtempSync(join(tmpdir(), "wm-kc-"));
  const pw = "corr ect 'horse\" $battery";
  const stub = stubStore(home);
  const env = { WAFERMAP_HOME: home, WAFERMAP_PASSWORD: pw, ...(stub.PATH ? { PATH: stub.PATH } : {}) };
  assert.equal(cli(["init"], env).status, 0);
  const on = cli(["keychain", "on"], env);
  assert.equal(on.status, 0, on.stderr);
  const status = cli(["keychain"], { ...env, WAFERMAP_PASSWORD: "" });
  assert.match(status.stdout, /It unlocks the wallet/);
  if (process.platform === "win32") assert.ok(existsSync(join(home, "mcp-password.dpapi")));
  else assert.ok(!readFileSync(stub.db, "utf8").includes(pw)); // the store received it encoded, never as typed
  const wrong = cli(["keychain", "on"], { ...env, WAFERMAP_PASSWORD: "not the password" });
  assert.notEqual(wrong.status, 0);
  assert.equal(cli(["keychain", "off"], env).status, 0);
  assert.match(cli(["keychain"], env).stdout, /^Off/);
});

// ---- $WAFERMAP holder discount ----

test("call() names the paying wallet to Wafermap (X-Wafermap-Payer); pay() never sends it to a third party", async () => {
  const seen = [];
  const s = createServer((req, res) => {
    seen.push({ url: req.url, payer: req.headers["x-wafermap-payer"] ?? null });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: "r", result: { ok: true } }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const { wm } = wallet(url);
    await wm.call("r");
    await wm.pay(`${url}/third-party`);
    assert.equal(seen[0].payer, wm.address);
    assert.equal(seen[1].payer, null);
  } finally {
    await new Promise((r) => (s.closeAllConnections(), s.close(r)));
  }
});

// ---- 0.4.3: `wafermap resources` has a time limit (third public review) ----

test("wafermap resources: a catalog server that never answers gives up with `timeout`", async () => {
  const s = createServer(() => {}); // accepts the connection, never answers
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    const t0 = Date.now();
    const r = await new Promise((done) => {
      const p = spawn(process.execPath, [CLI, "resources"], { env: { ...process.env, WAFERMAP_URL: url, WAFERMAP_TIMEOUT_MS: "500" } });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (status) => done({ status, err }));
    });
    assert.notEqual(r.status, 0);
    assert.match(r.err, /did not answer within 1 s\. Nothing was paid\. \(timeout\)/);
    assert.ok(Date.now() - t0 < 10_000);
    await assert.rejects(listResources(url, 300), (e) => e.code === "timeout");
  } finally {
    await new Promise((r) => (s.closeAllConnections(), s.close(r)));
  }
});

test("listResources: reads the catalog, and an error page is `network_error`, not an empty list", async () => {
  let ok = true;
  const s = createServer((req, res) => {
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(ok ? JSON.stringify({ data: [{ id: "gas-now", price: 0.001 }] }) : "{}");
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    assert.deepEqual((await listResources(url)).map((x) => x.id), ["gas-now"]);
    ok = false;
    await assert.rejects(listResources(url), (e) => e.code === "network_error");
  } finally {
    await new Promise((r) => (s.closeAllConnections(), s.close(r)));
  }
});

// ---- 0.4.4: holder pass and Pro free calls ----

test("call() sends a holder pass that verifies for this wallet; pay() and marketplace calls never get one", async () => {
  const seen = [];
  const s = createServer((req, res) => {
    seen.push({ url: req.url, pass: req.headers["x-wafermap-pass"] ?? null });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: "r", result: { ok: true }, receipt: null, free: { wallet: "w", left: 9, perDay: 10 } }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const { wm, log } = wallet(url);
    const out = await wm.call("r");
    await wm.call("m/some-listing");
    await wm.pay(`${url}/third-party`);
    assert.deepEqual(out.free, { wallet: "w", left: 9, perDay: 10 });
    assert.equal(log.length, 0); // a free call records no payment
    const p = decodePass(seen[0].pass);
    assert.equal(p.address, wm.address);
    assert.ok(p.exp - p.iat <= 86400);
    assert.ok(await verifyMessage({ address: p.address, message: passMessage(p.address, p.iat, p.exp), signature: p.sig }));
    assert.equal(seen[1].pass, null);
    assert.equal(seen[2].pass, null);
    assert.equal(await wm.holderPass(), seen[0].pass); // reused, not re-signed per call
  } finally {
    await new Promise((r) => (s.closeAllConnections(), s.close(r)));
  }
});

// ---- 0.4.5: paying Wafermap in $WAFERMAP (Permit2, burned) ----

test("--pay wafermap signs a Permit2 transfer of the exact quote to Wafermap's relayer; pay() never signs one", async () => {
  const relayer = privateKeyToAccount(generatePrivateKey()).address;
  const TOKEN = "0xfda080f64d84c989cfc50ff18253542cfe502db3";
  const token = (over = {}) => ({ scheme: "wafermap-permit2", network: "eip155:4663", asset: TOKEN, amount: "100000000000000000000", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 120, extra: { permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", spender: relayer, usd: 0.002, decimals: 18, ...over.extra }, ...over });
  let offer = token();
  const got = [];
  const s = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const q = { x402Version: 2, resource: { url: req.url }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "4000", asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }, offer] };
        res.writeHead(402, { "payment-required": b64(q), "content-type": "application/json" });
        return res.end(JSON.stringify(q));
      }
      got.push(unb64(sig));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resource: "r", result: { ok: true }, receipt: { network: "eip155:4663", asset: "WAFERMAP", amountTokens: 100, amountUsd: 0.002, burned: true, tx: "0xabc" } }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    // only a relayer this build knows is ever a spender
    let price = 0.00002;
    const { wm, log } = wallet(url, { rpc: { robinhood: "http://127.0.0.1:9" }, tokenPriceUsd: async () => price });
    await assert.rejects(wm.call("r", {}, { payIn: "wafermap" }), (e) => e.code === "token_not_offered");
    assert.equal(got.length, 0);
    WAFERMAP_RELAYERS.push(relayer);
    // 100 tokens at $0.0001 is $0.01, far above the quote's $0.002: refused before signing
    price = 0.0001;
    await assert.rejects(wm.call("r", {}, { payIn: "wafermap" }), (e) => e.code === "price_mismatch");
    assert.equal(got.length, 0);
    price = 0.00002;
    const out = await wm.call("r", {}, { payIn: "wafermap" });
    assert.equal(out.receipt.asset, "WAFERMAP");
    const p = got[0];
    assert.equal(p.accepted.scheme, "wafermap-permit2");
    assert.equal(p.payload.owner, wm.address);
    assert.equal(p.payload.permit.permitted.amount, "100000000000000000000");
    const deadline = BigInt(p.payload.permit.deadline);
    assert.ok(deadline - BigInt(Math.floor(Date.now() / 1000)) <= 120n);
    const ok = await verifyTypedData({ address: wm.address, domain: { name: "Permit2", chainId: 4663, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }, types: { PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }], TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }, primaryType: "PermitTransferFrom", message: { permitted: { token: TOKEN, amount: 10n ** 20n }, spender: relayer, nonce: BigInt(p.payload.permit.nonce), deadline }, signature: p.payload.signature });
    assert.ok(ok, "permit signed for the relayer as spender");
    assert.equal(log.find((e) => e.status === "signed").usd, 0.002); // counted against the caps at its USD value

    // a third-party service offering the same option gets a stablecoin payment, never a permit
    await wm.pay(`${url}/x`);
    assert.equal(got[1].accepted.scheme, "exact");

    // an option that does not burn, or names another Permit2, is ignored
    offer = token({ payTo: relayer }); // not the dead address: not a burn
    await assert.rejects(wm.call("r", {}, { payIn: "wafermap" }), (e) => e.code === "token_not_offered");
    offer = token({ extra: { permit2: relayer } });
    await assert.rejects(wm.call("r", {}, { payIn: "wafermap" }), (e) => e.code === "token_not_offered");
    await assert.rejects(wm.call("m/listing", {}, { payIn: "wafermap" }), (e) => e.code === "token_not_offered");
  } finally {
    WAFERMAP_RELAYERS.length = 0;
    await new Promise((r) => (s.closeAllConnections(), s.close(r)));
  }
});
