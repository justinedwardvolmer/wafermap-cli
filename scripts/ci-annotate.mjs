// CI only: rerun the tests with TAP output and print each failing test as a GitHub annotation, so
// the reason shows on the run page without downloading the logs.
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { encoding: "utf8" });
const blocks = (r.stdout ?? "").split(/\n(?=\s*(?:not )?ok \d)/).filter((b) => /^\s*not ok/.test(b));
for (const b of blocks) console.log(`::error::${b.slice(0, 3000).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")}`);
if (!blocks.length) console.log("No failing test on the rerun.");
