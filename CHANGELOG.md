# Changelog

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
