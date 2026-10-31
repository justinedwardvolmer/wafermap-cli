# wafermap

The CLI, SDK and MCP server behind [Wafermap](https://wafermap.xyz): an x402 wallet for AI agents. One local, encrypted key that can:

- **call** Wafermap's pay-per-call resources (LLMs, image and audio models, web reading, on-chain data, tokenized stocks, prediction markets)
- **discover** third-party x402 services in the open x402 index and **pay** them
- **swap** tokens through the KyberSwap aggregator

Every payment is checked against a per-payment cap and a daily cap before anything is signed. Swaps have their own per-swap cap. Payments settle in USDG on Robinhood Chain or USDC on Solana, Base, Arbitrum or Polygon and are gasless; swaps need a little ETH for gas.

## Install

```bash
npm i -g https://wafermap.xyz/cli/wafermap.tgz
wafermap init
```

`init` creates a key and encrypts it with your password (scrypt + AES-256-GCM) in `~/.wafermap/keystore.json`. Back it up with `wafermap export-key`. Then send a few dollars of USDC on Solana to the Solana address it prints, or USDG (Robinhood Chain) or USDC (Base, Arbitrum, Polygon) to its EVM address.

The Solana address comes from the same key (derived with HMAC-SHA256), so one backup covers both. `wafermap export-key --solana` prints the Solana secret key in the form Phantom and Solflare import. `wafermap address` shows both addresses.

## CLI

```bash
wafermap balance
wafermap limits --per-payment 0.1 --per-day 1 --per-swap 25 --network robinhood
wafermap resources stock
wafermap call prediction-markets query="fed rates"
wafermap call flux-2-dev prompt="a glossy silicon wafer" --out wafer.png
wafermap discover weather
wafermap pay https://x402.agentindex.world/weather city=Jakarta
wafermap swap 0.01 ETH USDG
wafermap history
```

Add `--yes` to skip the confirmation prompt (caps still apply), `--network base`, `arbitrum`, `polygon` or `solana` to pay in USDC on that network (swaps run on `robinhood` or `base`). Set `WAFERMAP_PASSWORD` to avoid the password prompt in scripts.

## MCP server

Give Claude Desktop, Cursor or any MCP client the same wallet:

```json
{
  "mcpServers": {
    "wafermap": {
      "command": "wafermap",
      "args": ["mcp"],
      "env": { "WAFERMAP_PASSWORD": "your wallet password" }
    }
  }
}
```

Tools: `wafermap_wallet`, `wafermap_resources`, `wafermap_call`, `wafermap_discover`, `wafermap_pay`, `wafermap_swap_quote`, `wafermap_swap`, `wafermap_history`. Swaps from MCP are off until you run `wafermap limits --mcp-swaps on`.

## SDK

```ts
import { Wafermap } from "wafermap";

const wm = new Wafermap({ privateKey: process.env.AGENT_KEY as `0x${string}`, limits: { perPayment: 0.05, perDay: 2 } });

const { result, receipt } = await wm.call("stock-signal", { symbol: "TSLA" });
const services = await wm.discover("token price");
const paid = await wm.pay(services[0].url, { method: "POST", input: { symbol: "ETH" }, network: "base" });
const quote = await wm.swapQuote("ETH", "USDG", "0.01");
await wm.swap(quote);
```

Pass `approve: (a) => boolean` to confirm each payment or swap yourself, and `ledger` to persist spending for the daily cap. Lower level: `x402fetch(url, init, { signer })` pays any x402 v1 or v2 endpoint.

## Where the limits live

The caps sit with the key, on your machine. Before the wallet signs anything it reads the 402 quote and refuses when the price is above the per-payment cap or would take today's spend past the daily cap, so nothing is signed and nothing can be charged. Wafermap's server only quotes, verifies the signature, runs the resource and settles if it worked; it never sees your key or your caps. A budget written in a prompt is an instruction, not a limit: set it with `wafermap limits`. More: https://wafermap.xyz/docs#limits

The checks are in [`src/core.ts`](src/core.ts) (`gate`), the keystore in [`src/store.ts`](src/store.ts), payment signing in [`shared/x402client.ts`](shared/x402client.ts) and [`shared/solana.ts`](shared/solana.ts).

## Build from source

```bash
git clone <this repo> && cd wafermap-cli
npm ci
npm run build          # dist/cli.js, dist/index.js and type declarations
node dist/cli.js --help
npm i -g .             # optional: install this build as `wafermap`
```

Layout: `src/` is the CLI, SDK and MCP server; `shared/` is the x402 client, the Solana payment builder, the swap helpers and the resource catalog, the same files the Wafermap site uses.

## Files

`~/.wafermap/keystore.json` (encrypted key), `config.json` (caps, network), `spend.jsonl` (history). Override the folder with `WAFERMAP_HOME`, the RPCs with `WAFERMAP_RPC_ROBINHOOD` / `WAFERMAP_RPC_BASE`.

Docs: https://wafermap.xyz/docs#cli · Security: [SECURITY.md](SECURITY.md) · License: [MIT](LICENSE)
