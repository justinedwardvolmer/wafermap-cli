// Bundles our own code (src + shared) into dist; npm dependencies stay external.
import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync("src/version.ts", `// Replaced at build time from package.json.\nexport const VERSION = "${pkg.version}";\n`);
rmSync("dist", { recursive: true, force: true });

const common = { bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" };
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", banner: { js: "" } });
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js" });

// Type declarations for SDK users.
execSync("npx tsc -p tsconfig.json", { stdio: "inherit" });
console.log(`built wafermap ${pkg.version}`);
