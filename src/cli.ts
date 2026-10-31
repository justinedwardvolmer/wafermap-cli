#!/usr/bin/env node
// The `wafermap` command. Run `wafermap help` for the list.
import { createInterface } from "node:readline";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PAY_NETWORKS, payNetworkOf } from "../shared/catalog";
import { NETS, WafermapError, isNet, type Approval, type Net } from "./core.js";
import { openWallet } from "./local.js";
import { solanaKeyFromEvm } from "../shared/solana";
import { HOME, config, hasWallet, keystoreAddress, keystoreSolana, loadKey, rememberSolana, saveConfig, saveKey, spendLog } from "./store.js";
import { VERSION } from "./version.js";

const HELP = `wafermap ${VERSION}: an x402 wallet for agents (Robinhood Chain, Solana, Base, Arbitrum, Polygon)

Wallet
  wafermap init [--import]              create (or import) the agent wallet, encrypted with a password
  wafermap address                      print the wallet addresses (EVM and Solana)
  wafermap balance                      USDG / USDC and gas on every payment network
  wafermap limits [--per-payment 0.1] [--per-day 1] [--per-swap 25] [--network <net>] [--mcp-swaps on|off] [--mcp-confirm on|off]
  wafermap history [--days 7]           payments and swaps from this machine
  wafermap export-key [--solana]        print the private key, or the Solana key for Phantom/Solflare

Pay
  wafermap resources [words]            Wafermap's pay-per-call catalog
  wafermap call <id> [field=value ...]  run a resource and pay its price  (--json '{...}' for complex input)
  wafermap discover <words>             search third-party x402 services
  wafermap pay <url> [field=value ...]  call any x402 URL and pay it       (--post to send a JSON body)

Trade
  wafermap swap <amount> <from> <to>    swap through KyberSwap on robinhood or base, e.g. wafermap swap 0.01 ETH USDG

Agents
  wafermap mcp                          run as an MCP server (stdio); needs WAFERMAP_PASSWORD

Common flags: --network robinhood|solana|base|arbitrum|polygon   --yes (skip the confirmation)
Files live in ${HOME}. Docs: https://wafermap.xyz/docs#cli`;

type Args = { _: string[]; flags: Record<string, string | true> };
function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && !["yes", "post", "import"].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = process.stdout;
      (rl as any)._writeToOutput = (s: string) => out.write(s.includes(question) ? question : s === "\r\n" || s === "\n" ? s : "");
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a);
    });
  });
}

async function password(): Promise<string> {
  return process.env.WAFERMAP_PASSWORD ?? (await ask("Wallet password: ", true));
}

const net = (v: unknown): Net | undefined => (isNet(v) ? v : v === undefined || v === true ? undefined : die(`--network must be one of ${NETS.join(", ")}`));
function die(msg: string): never {
  console.error(`✕ ${msg}`);
  process.exit(1);
}

/** field=value pairs (numbers stay numbers) plus an optional --json object. */
function inputOf(a: Args, from = 0): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof a.flags.json === "string") {
    try {
      Object.assign(input, JSON.parse(a.flags.json));
    } catch {
      die("--json is not valid JSON");
    }
  }
  for (const kv of a._.slice(from)) {
    const i = kv.indexOf("=");
    if (i < 1) die(`"${kv}" should look like field=value`);
    const v = kv.slice(i + 1);
    input[kv.slice(0, i)] = /^-?\d+(\.\d+)?$/.test(v) && !/^0x/i.test(v) && v.length < 16 ? Number(v) : v;
  }
  return input;
}

function approver(yes: boolean) {
  return async (a: Approval) => {
    if (yes) return true;
    const what = a.kind === "swap" ? `Swap ${a.what} (${a.detail}), worth $${a.usd.toFixed(2)}` : `Pay $${a.usd} on ${a.network} for ${a.what}`;
    return /^y(es)?$/i.test((await ask(`${what}? [y/N] `)).trim());
  };
}

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const EXPLORER = (n: string) => PAY_NETWORKS[payNetworkOf(n) ?? "robinhood"].explorer;

function printResult(r: any) {
  const scrub = (x: any): any =>
    typeof x === "string" && x.startsWith("data:") ? `[${x.slice(5, x.indexOf(";"))}, ${Math.round(x.length / 1365)} KB, use --out to save]` : Array.isArray(x) ? x.map(scrub) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, scrub(y)])) : x;
  console.log(typeof r === "string" ? r : JSON.stringify(scrub(r), null, 2));
}

async function saveMedia(r: any, out: string) {
  const { writeFileSync } = await import("node:fs");
  const media = JSON.stringify(r).match(/data:[\w/.+-]+;base64,[A-Za-z0-9+/=]+/);
  if (!media) return console.log("(no image or audio in the result to save)");
  writeFileSync(out, Buffer.from(media[0].split(",")[1], "base64"));
  console.log(`Saved ${out}`);
}

async function main() {
  const a = parse(process.argv.slice(2));
  const cmd = a._.shift() ?? (a.flags.version ? "version" : "help");
  const yes = a.flags.yes === true;

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    case "version":
    case "--version":
      return console.log(VERSION);

    case "init": {
      if (hasWallet()) die(`A wallet already exists (${keystoreAddress()}). Delete ${HOME}/keystore.json first if you really want a new one.`);
      let key: `0x${string}`;
      if (a.flags.import) {
        const k = (await ask("Private key (0x…): ", true)).trim();
        key = (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die("That is not a 64-character hex private key.");
      } else key = generatePrivateKey();
      const p1 = process.env.WAFERMAP_PASSWORD ?? (await ask("New password (8+ characters): ", true));
      if (!process.env.WAFERMAP_PASSWORD && p1 !== (await ask("Repeat password: ", true))) die("Passwords do not match.");
      const acct = privateKeyToAccount(key);
      const sol = solanaKeyFromEvm(key).address;
      saveKey(key, acct.address, p1, sol);
      saveConfig(config());
      console.log(`✓ Agent wallet ${acct.address}
  Solana address ${sol} (derived from the same key)
  Key encrypted in ${HOME}/keystore.json. Forget the password and the key is gone: run \`wafermap export-key\` to back it up.
  Fund it with a few dollars of USDC on Solana (Solana address), or USDG on Robinhood Chain or USDC on Base, Arbitrum or Polygon (EVM address). Payments are gasless; swaps need a little ETH.
  Caps: $0.10 per payment, $1 per day, $25 per swap. Change with \`wafermap limits\`.`);
      return;
    }

    case "address": {
      const evm = keystoreAddress() ?? die("No wallet yet. Run `wafermap init`.");
      let sol = keystoreSolana();
      if (!sol && process.env.WAFERMAP_PASSWORD) rememberSolana((sol = solanaKeyFromEvm(loadKey(process.env.WAFERMAP_PASSWORD)).address));
      console.log(`evm     ${evm}`);
      return console.log(`solana  ${sol ?? "(unlock once to see it: WAFERMAP_PASSWORD=… wafermap address)"}`);
    }

    case "export-key": {
      const k = loadKey(await password());
      console.error("Anyone with this key can spend the wallet. Do not paste it into chats or websites.");
      if (a.flags.solana) {
        const s = solanaKeyFromEvm(k);
        rememberSolana(s.address);
        console.error(`Solana ${s.address}. Import this secret key in Phantom or Solflare ("Import private key"):`);
        return console.log(s.secretKey);
      }
      return console.log(k);
    }

    case "limits": {
      const c = config();
      const num = (k: string) => {
        const v = a.flags[k];
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!(n > 0)) die(`--${k} must be a positive number`);
        return n;
      };
      c.limits.perPayment = num("per-payment") ?? c.limits.perPayment;
      c.limits.perDay = num("per-day") ?? c.limits.perDay;
      c.limits.perSwap = num("per-swap") ?? c.limits.perSwap;
      if (c.limits.perPayment > c.limits.perDay) die("The per-payment cap cannot be above the daily cap.");
      c.network = net(a.flags.network) ?? c.network;
      if (a.flags["mcp-swaps"] !== undefined) c.mcpSwaps = a.flags["mcp-swaps"] === "on";
      if (a.flags["mcp-confirm"] !== undefined) c.mcpConfirm = a.flags["mcp-confirm"] === "on";
      if (Object.keys(a.flags).length) saveConfig(c);
      return console.log(`Per payment $${c.limits.perPayment} · per day $${c.limits.perDay} · per swap $${c.limits.perSwap} · network ${c.network} · swaps from MCP ${c.mcpSwaps ? "on" : "off"} · confirm each MCP payment ${c.mcpConfirm ? "on" : "off"}`);
    }

    case "history": {
      const days = Number(a.flags.days ?? 7);
      const since = Date.now() - days * 86400_000;
      const rows = spendLog().filter((e) => e.at >= since);
      if (!rows.length) return console.log(`Nothing in the last ${days} days.`);
      for (const e of rows.reverse()) console.log(`${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")}  ${e.kind.padEnd(8)}  ${e.kind === "swap" ? "      " : `$${e.usd}`.padEnd(8)}  ${e.network.padEnd(9)}  ${e.what}${e.tx ? `  ${EXPLORER(e.network)}/tx/${e.tx}` : ""}`);
      const total = rows.filter((e) => e.kind !== "swap").reduce((s, e) => s + e.usd, 0);
      return console.log(`\nSpent $${total.toFixed(4)} on ${rows.filter((e) => e.kind !== "swap").length} payments.`);
    }

    case "resources": {
      const q = a._.join(" ").toLowerCase();
      const r = await fetch(`${process.env.WAFERMAP_URL ?? "https://wafermap.xyz"}/v1/resources`).then((x) => x.json() as any);
      for (const x of (r.data ?? []).filter((x: any) => !q || `${x.id} ${x.name} ${x.summary} ${x.category}`.toLowerCase().includes(q))) console.log(`${x.id.padEnd(22)} $${String(x.price).padEnd(7)} ${x.summary}`);
      return;
    }

    case "discover": {
      const q = a._.join(" ");
      if (q.length < 2) die("Say what you are looking for: wafermap discover weather");
      const wm = openWallet(await password());
      const list = await wm.discover(q, Number(a.flags.limit ?? 10));
      for (const s of list) console.log(`${s.payable ? "●" : "○"} ${s.priceUsd !== null ? `$${s.priceUsd}`.padEnd(8) : "—".padEnd(8)} ${s.method.padEnd(4)} ${s.url}\n    ${s.description.slice(0, 140)}${s.input ? `\n    input: ${JSON.stringify(s.input).slice(0, 140)}` : ""}`);
      return console.log(`\n● payable with USDG (Robinhood Chain) or USDC (Solana, Base, Arbitrum, Polygon)   ○ other networks only`);
    }

    case "call": {
      const id = a._[0] ?? die("Which resource? e.g. wafermap call gas-now network=base");
      const wm = openWallet(await password(), approver(yes));
      const out = await wm.call(id, inputOf(a, 1), { network: net(a.flags.network) });
      if (out.receipt) console.error(`✓ Paid $${out.receipt.amountUsd} ${out.receipt.asset} · ${EXPLORER(out.receipt.network)}/tx/${out.receipt.tx}`);
      if (typeof a.flags.out === "string") await saveMedia(out.result, a.flags.out);
      return printResult(out.result);
    }

    case "pay": {
      const url = a._[0] ?? die("Which URL? e.g. wafermap pay https://example.com/api city=Paris");
      if (!/^https:\/\//.test(url)) die("Only https:// URLs.");
      const wm = openWallet(await password(), approver(yes));
      const out = await wm.pay(url, { method: a.flags.post ? "POST" : "GET", input: inputOf(a, 1), network: net(a.flags.network) });
      if (out.paid) console.error(`✓ Paid $${out.paid.usd} on ${out.paid.network}${out.paid.tx ? ` · ${EXPLORER(out.paid.network)}/tx/${out.paid.tx}` : ""}`);
      return printResult(out.result);
    }

    case "balance": {
      const addr = keystoreAddress() ?? die("No wallet yet. Run `wafermap init`.");
      const { Wafermap } = await import("./core.js");
      // Balances need no key: a throwaway account with the same address is enough to read.
      const wm = new Wafermap({ account: { ...privateKeyToAccount(generatePrivateKey()), address: addr as `0x${string}` } as any, solanaAddress: keystoreSolana() ?? undefined, baseUrl: process.env.WAFERMAP_URL, rpc: { robinhood: process.env.WAFERMAP_RPC_ROBINHOOD, base: process.env.WAFERMAP_RPC_BASE, arbitrum: process.env.WAFERMAP_RPC_ARBITRUM, polygon: process.env.WAFERMAP_RPC_POLYGON, solana: process.env.WAFERMAP_RPC_SOLANA } });
      const b = await wm.balances();
      console.log(addr);
      for (const n of NETS) console.log(`  ${n.padEnd(10)} ${b[n] ? `${Number(b[n]!.stable).toFixed(4)} ${b[n]!.symbol}   ${Number(b[n]!.eth).toPrecision(4)} ${b[n]!.gas}` : n === "solana" && !wm.solanaAddress ? "run `wafermap address` once with WAFERMAP_PASSWORD set" : "unreadable (RPC did not answer)"}`);
      return;
    }

    case "swap": {
      const [amount, from, to] = a._;
      if (!amount || !from || !to) die("Usage: wafermap swap <amount> <from> <to>  e.g. wafermap swap 0.01 ETH USDG");
      const wm = openWallet(await password(), approver(yes));
      const q = await wm.swapQuote(from, to, amount, net(a.flags.network));
      console.log(`${q.network}: pay ${q.amountIn} ${q.tokenIn.symbol}${q.amountInUsd ? ` ($${q.amountInUsd.toFixed(2)})` : ""} → about ${q.amountOut} ${q.tokenOut.symbol}${q.amountOutUsd ? ` ($${q.amountOutUsd.toFixed(2)})` : ""} · cost ${q.impactPct ?? "?"}% · gas ~$${q.gasUsd?.toFixed(3) ?? "?"}`);
      const slip = a.flags.slippage !== undefined ? Number(a.flags.slippage) : 1;
      if (!(slip > 0 && slip <= 5)) die("--slippage must be between 0 and 5 (percent)");
      const r = await wm.swap(q, { slippageBps: Math.round(slip * 100), step: (s) => console.error(`… ${s}`) });
      return console.log(`✓ Swapped · ${EXPLORER(q.network)}/tx/${r.tx}`);
    }

    case "mcp": {
      const { runMcp } = await import("./mcp.js");
      return runMcp();
    }

    default:
      die(`Unknown command "${cmd}". Run \`wafermap help\`.`);
  }
}

main().catch((e) => {
  if (e instanceof WafermapError && e.code === "declined") die("Cancelled. Nothing was paid.");
  die(e instanceof WafermapError ? `${e.message} (${e.code})` : (e?.shortMessage ?? e?.message ?? String(e)));
});
