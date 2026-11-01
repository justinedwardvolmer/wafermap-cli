// The wallet password for `wafermap mcp`, kept by the operating system instead of in plain text in
// the MCP client's config: Windows DPAPI (a file only this Windows user can decrypt), the macOS
// Keychain, or the Secret Service on Linux (GNOME Keyring, KWallet) through `secret-tool`.
// It protects the password at rest (config files, backups, screenshots, dotfile repos). A program
// running as you can still ask the OS for it, as it could read the keystore and wait for you to type.
// The password never goes on a command line: it is passed on stdin, and stored as "wm1:<base64>" so
// any characters survive every backend.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME, secureWrite } from "./store.js";

const SERVICE = "wafermap";
const ACCOUNT = "mcp";
const DPAPI_FILE = join(HOME, "mcp-password.dpapi");

export type Backend = "windows-dpapi" | "macos-keychain" | "secret-service";

export function backend(): Backend | null {
  if (process.platform === "win32") return "windows-dpapi";
  if (process.platform === "darwin") return "macos-keychain";
  if (process.platform === "linux") return "secret-service";
  return null;
}

export const BACKEND_NAME: Record<Backend, string> = { "windows-dpapi": "Windows DPAPI", "macos-keychain": "macOS Keychain", "secret-service": "Secret Service (secret-tool)" };

const encode = (pw: string) => `wm1:${Buffer.from(pw, "utf8").toString("base64")}`;
function decode(v: string): string | null {
  const s = v.replace(/\r?\n$/, "");
  return s.startsWith("wm1:") ? Buffer.from(s.slice(4), "base64").toString("utf8") : null;
}

function run(cmd: string, args: string[], input?: string, env?: Record<string, string>) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000 });
  if (r.error) throw new Error(`${cmd} could not run: ${(r.error as any).code === "ENOENT" ? "not installed" : r.error.message}`);
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

const PS = ["-NoProfile", "-NonInteractive", "-Command"];

/** Store the password. Throws with the reason when the OS store is not available. */
export function keychainSet(password: string) {
  const b = backend();
  const value = encode(password);
  if (b === "windows-dpapi") {
    const r = run("powershell", [...PS, "$p = [Console]::In.ReadToEnd(); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString"], value);
    if (!r.ok || !r.out.trim()) throw new Error(`DPAPI refused: ${r.err || "no output"}`);
    secureWrite(DPAPI_FILE, r.out.trim());
  } else if (b === "macos-keychain") {
    // `security -i` reads the command from stdin; -X takes the secret as hex, so no quoting and no argv.
    const r = run("security", ["-i"], `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -l "Wafermap MCP wallet password" -X ${Buffer.from(value, "utf8").toString("hex")}\n`);
    if (!r.ok || r.err) throw new Error(`Keychain refused: ${r.err || "unknown error"}`);
  } else if (b === "secret-service") {
    const r = run("secret-tool", ["store", "--label=Wafermap MCP wallet password", "service", SERVICE, "account", ACCOUNT], value);
    if (!r.ok) throw new Error(`secret-tool refused: ${r.err || "is a Secret Service (GNOME Keyring, KWallet) running?"}`);
  } else throw new Error(`No OS keychain support on ${process.platform}.`);
}

/** The stored password, or null when none is stored (or the store cannot be read). */
export function keychainGet(): string | null {
  const b = backend();
  try {
    if (b === "windows-dpapi") {
      if (!existsSync(DPAPI_FILE)) return null;
      const r = run("powershell", [...PS, "$s = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $env:WM_DPAPI_FILE).Trim()); [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"], undefined, { WM_DPAPI_FILE: DPAPI_FILE });
      return r.ok ? decode(r.out) : null;
    }
    if (b === "macos-keychain") {
      const r = run("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
      return r.ok ? decode(r.out) : null;
    }
    if (b === "secret-service") {
      const r = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
      return r.ok ? decode(r.out) : null;
    }
  } catch {
    /* the store's tool is missing or failed: same as nothing stored */
  }
  return null;
}

export function keychainClear() {
  const b = backend();
  if (b === "windows-dpapi") rmSync(DPAPI_FILE, { force: true });
  else if (b === "macos-keychain") run("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
  else if (b === "secret-service") run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
}
