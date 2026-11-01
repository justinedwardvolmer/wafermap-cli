# Changelog

## 0.4.0 (2 Nov 2026)

From the second public review by @whoiskn0why, thank you.

- **Shorter payment authorizations.** EVM payments are signed for at most 90 seconds (was up to 300), or less when the server asks for less. That is the window in which "a failed call costs $0" rests on the server's word; `wafermap history --verify` still checks every one on-chain afterwards.
- **Time limits.** Requests to paid resources and services, Wafermap's API, the swap API and Solana RPC give up after 60 seconds (`timeoutMs` in the SDK, `DEFAULT_TIMEOUT_MS`); EVM RPC keeps viem's time-outs. Before, a server that never answered held a call forever. A paid call that times out after signing says the payment stays counted (and, for EVM payments, until when it can be executed); one that times out before signing says nothing was paid.
- **Swaps are checked before anything is signed.** The build now comes first and the approval after it. The quote and the build must name KyberSwap's router (`KYBER_ROUTER`, `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`). The swap calldata is decoded (`decodeSwap`) and must trade the quoted tokens, spend exactly the quoted amount, pay the output to this wallet, take no fee, and set an on-chain minimum output no lower than the built output less your slippage; the built output must be within your slippage of the quote, and ETH is sent only when selling ETH. Otherwise nothing is approved or sent (`unexpected_router`, `unexpected_calldata`, `build_mismatch`, `price_moved`). `amountOutMin` is now the minimum encoded in the transaction.
- **The MCP password can leave the config file.** `wafermap keychain on` stores it with Windows DPAPI, the macOS Keychain or the Linux Secret Service; `wafermap mcp` reads it from there, and warns when `WAFERMAP_PASSWORD` is still set in plain text.
- An empty `WAFERMAP_PASSWORD` counts as not set. `wafermap keychain off` checks that the password is really gone.
- Tests for all of the above (`test/hardening.test.mjs`: real DPAPI on Windows; the macOS and Linux stores are exercised against a stub). CI also runs on Windows and macOS.
- The SDK exports `quoteSwap`, `executeSwap`, `decodeSwap`, `KYBER_ROUTER`, `MAX_VALIDITY_SECONDS` and `DEFAULT_TIMEOUT_MS`.

npm: the name `wafermap` is refused by the registry for everyone (too similar to an existing package), so it cannot be published by us or anyone else. Install from https://wafermap.xyz/cli/wafermap.tgz or from this repository.

## 0.3.3 (1 Nov 2026)

**Fix: the daily cap no longer trusts the server.** Reported publicly in a code review by @whoiskn0why, thank you.

Before: the spend record was written after the call, from the server's receipt (`call()`), or as $0 when the server answered with an error (`pay()`). A server that reported $0, sent no receipt, answered with an error or dropped the connection could take signed payments that never counted towards the daily cap. With a $0.10 cap, $0.15 in signed payments could go through.

Now:
- Every payment is recorded at its full signed amount the moment it is signed, before it is sent, and stays counted whatever the server answers. The outcome (ok / failed / refused) is written as a second line that adds nothing to the total.
- Check, sign and record run one payment at a time within a process, so concurrent calls cannot both pass the cap on the same remaining budget (found while writing the tests). Across processes sharing one wallet (two MCP clients, CLI + MCP), each signed payment is checked again against the shared log before it is sent and dropped, never sent, if another process used the budget meanwhile (found in our own adversarial review).
- `wafermap history --verify` (SDK: `checkPayment`) reads `authorizationState` on the token contract to show which signed EVM payments were executed and which expired unused, without trusting any server.
- `wafermap history` shows each payment's status and notes that log lines from before 0.3.3 hold what the server reported.
- Tests (`npm test`): the caps against a local mock server that lies, errors, refuses or hangs up; CI on Node 20 and 22.

Older `spend.jsonl` lines are still read; `mergeLog` joins the new two-line records.

## 0.3.2

Opt-in per-payment confirmation for the MCP server (`wafermap limits --mcp-confirm on`).

## 0.3.1

First public source release: CLI, SDK and MCP server.
