// The caps against a server that lies. A local mock x402 server quotes $0.05 in USDC on Base and,
// once paid, misbehaves in one of several ways. The daily cap must count every payment the wallet
// signed, at its full amount, whatever the server answers. Run: npm test (after npm run build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generatePrivateKey } from "viem/accounts";
import { Wafermap, mergeLog, checkPayment } from "../dist/index.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** A mock x402 server. `mode` decides what happens after a payment arrives. */
async function mockServer({ price = "50000", mode = "ok", inputError = false } = {}) {
  const payments = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const quote = { x402Version: 2, resource: { url: req.url }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: price, asset: USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] };
        if (inputError) quote.inputError = { code: "invalid_input", message: "bad input" };
        res.writeHead(402, { "payment-required": b64(quote), "content-type": "application/json" });
        return res.end(JSON.stringify(quote));
      }
      payments.push(unb64(sig));
      if (mode === "hangup") return req.socket.destroy();
      if (mode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "upstream_failed", message: "boom" } }));
      }
      if (mode === "refuse") {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "insufficient_funds" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      // "lie" claims nothing was charged; "noreceipt" sends no receipt at all.
      const receipt = mode === "lie" ? { network: "eip155:8453", asset: "USDC", amountUsd: 0, payer: "x", tx: "0xabc", ms: 1 } : mode === "noreceipt" ? undefined : { network: "eip155:8453", asset: "USDC", amountUsd: Number(price) / 1e6, payer: "x", tx: "0xabc", ms: 1 };
      res.end(JSON.stringify({ resource: "r", result: { ok: true }, ...(receipt ? { receipt } : {}) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, payments, close: () => new Promise((r) => server.close(r)) };
}

function wallet(baseUrl, limits = {}, extra = {}) {
  const log = [];
  const wm = new Wafermap({ privateKey: generatePrivateKey(), baseUrl, network: "base", limits: { perPayment: 0.1, perDay: 1, ...limits }, ledger: { entries: () => log, record: (e) => void log.push(e) }, ...extra });
  return { wm, log };
}

for (const mode of ["lie", "noreceipt", "error", "refuse"]) {
  test(`call(): a signed payment counts in full when the server answers "${mode}"`, async () => {
    const s = await mockServer({ mode });
    try {
      const { wm, log } = wallet(s.url);
      await wm.call("r").catch(() => {});
      assert.equal(s.payments.length, 1);
      assert.equal(wm.spentToday(), 0.05);
      const rows = mergeLog(log);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, { lie: "ok", noreceipt: "ok", error: "failed", refuse: "refused" }[mode]);
    } finally {
      await s.close();
    }
  });
}

test("call(): a payment counts in full when the connection dies after it was sent", async () => {
  const s = await mockServer({ mode: "hangup" });
  try {
    const { wm, log } = wallet(s.url);
    await assert.rejects(wm.call("r"));
    assert.equal(s.payments.length, 1);
    assert.equal(wm.spentToday(), 0.05);
    assert.equal(mergeLog(log)[0].status, "signed");
  } finally {
    await s.close();
  }
});

for (const mode of ["lie", "error", "hangup"]) {
  test(`pay(): a third-party payment counts in full when the server answers "${mode}"`, async () => {
    const s = await mockServer({ mode });
    try {
      const { wm } = wallet(s.url);
      await wm.pay(`${s.url}/svc`, { method: "POST", input: {} }).catch(() => {});
      assert.equal(s.payments.length, 1);
      assert.equal(wm.spentToday(), 0.05);
    } finally {
      await s.close();
    }
  });
}

test("daily cap: a lying server cannot push spending past it (the slime test: $0.10 cap, $0.15 attempted)", async () => {
  const s = await mockServer({ mode: "lie" });
  try {
    const { wm } = wallet(s.url, { perDay: 0.1 });
    await wm.call("r");
    await wm.call("r");
    await assert.rejects(wm.call("r"), (e) => e.code === "over_daily_cap");
    assert.equal(s.payments.length, 2, "the third payment must never be signed");
    assert.equal(wm.spentToday(), 0.1);
  } finally {
    await s.close();
  }
});

test("daily cap: calls started together cannot share the same remaining budget", async () => {
  const s = await mockServer({ mode: "lie" });
  try {
    const { wm } = wallet(s.url, { perDay: 0.1 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => wm.call("r")));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(s.payments.length, 2);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "over_daily_cap"));
  } finally {
    await s.close();
  }
});

test("per-payment cap: a price above it is refused before signing", async () => {
  const s = await mockServer({ price: "200000" });
  try {
    const { wm, log } = wallet(s.url);
    await assert.rejects(wm.call("r"), (e) => e.code === "over_payment_cap");
    assert.equal(s.payments.length, 0);
    assert.equal(log.length, 0);
  } finally {
    await s.close();
  }
});

test("a quote that flags bad input is never signed", async () => {
  const s = await mockServer({ inputError: true });
  try {
    const { wm } = wallet(s.url);
    await assert.rejects(wm.call("r"), (e) => e.code === "invalid_input");
    assert.equal(s.payments.length, 0);
  } finally {
    await s.close();
  }
});

test("approve() returning false stops the payment before signing", async () => {
  const s = await mockServer();
  try {
    const { wm } = wallet(s.url, {}, { approve: () => false });
    await assert.rejects(wm.call("r"), (e) => e.code === "declined");
    assert.equal(s.payments.length, 0);
  } finally {
    await s.close();
  }
});

test("the signed authorization is for exactly the quoted amount and recipient, and is logged with its nonce", async () => {
  const s = await mockServer();
  try {
    const { wm, log } = wallet(s.url);
    await wm.call("r");
    const auth = s.payments[0].payload.authorization;
    assert.equal(auth.value, "50000");
    assert.equal(auth.to, PAY_TO);
    assert.equal(auth.from.toLowerCase(), wm.address.toLowerCase());
    assert.ok(Number(auth.validBefore) - Date.now() / 1000 <= 61);
    const row = mergeLog(log)[0];
    assert.equal(row.nonce, auth.nonce);
    assert.equal(row.validBefore, Number(auth.validBefore));
  } finally {
    await s.close();
  }
});

test("checkPayment(): Solana and lines without a nonce are reported as unknown", async () => {
  assert.equal(await checkPayment({ network: "solana", payer: "x", nonce: "0x1", validBefore: 1 }), "unknown");
  assert.equal(await checkPayment({ network: "base", payer: "0x0000000000000000000000000000000000000001" }), "unknown");
});

test("daily cap: separate wallet instances sharing one ledger (two MCP clients, or CLI + MCP) cannot both pass it", async () => {
  const s = await mockServer({ mode: "lie" });
  try {
    const key = generatePrivateKey();
    const shared = [];
    const ledger = { entries: () => shared, record: (e) => void shared.push(e) };
    // a slow approve widens the gap between the cap check and the booking, like a person confirming
    const approve = () => new Promise((r) => setTimeout(() => r(true), 100));
    const instances = Array.from({ length: 3 }, () => new Wafermap({ privateKey: key, baseUrl: s.url, network: "base", limits: { perPayment: 0.1, perDay: 0.1 }, ledger, approve }));
    const results = await Promise.allSettled(instances.flatMap((wm) => [wm.call("r"), wm.call("r")]));
    assert.ok(s.payments.length <= 2, `at most $0.10 may reach the server, got ${s.payments.length} payments`);
    assert.ok(instances[0].spentToday() <= 0.1 + 1e-9);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "over_daily_cap"));
    const aborted = mergeLog(shared).filter((e) => e.status === "aborted");
    assert.ok(aborted.every((e) => e.usd === 0));
  } finally {
    await s.close();
  }
});

test("mergeLog(): old single-line entries pass through and new two-line records join", () => {
  const log = [
    { at: 1, kind: "resource", what: "old", usd: 0.02, network: "base", tx: "0x1", payer: "a" },
    { at: 2, kind: "resource", what: "new", usd: 0.05, network: "base", tx: null, payer: "a", id: "x", status: "signed", nonce: "0x2", validBefore: 9 },
    { at: 3, kind: "resource", what: "new", usd: 0, network: "base", tx: "0x3", payer: "a", of: "x", status: "ok", reported: 0 },
  ];
  const rows = mergeLog(log);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].status, rows[1].tx, rows[1].usd, rows[1].reported], ["ok", "0x3", 0.05, 0]);
});
