#!/usr/bin/env node
// Ensures a QuantumCoin devnet is installed and running for tests, on any OS.
//
// - Detects the platform and downloads the matching devnet package
//   (windows-devnet.zip / mac-devnet.tar.gz / ubuntu-devnet.tar.gz).
// - If the devnet directory already contains the node binary, the download
//   is skipped. If the RPC endpoint already answers, the running node is reused.
// - Launches the official connectvalidator script with an HTTP RPC port and
//   waits for the RPC to come up.
//
// Usage: node scripts/devnet.js ensure

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";

const PLATFORMS = {
  win32: { asset: "windows-devnet.zip", binary: "dp.exe" },
  darwin: { asset: "mac-devnet.tar.gz", binary: "dp" },
  linux: { asset: "ubuntu-devnet.tar.gz", binary: "dp" },
};
const PLATFORM = PLATFORMS[process.platform];
if (!PLATFORM) {
  console.error(`devnet: unsupported platform ${process.platform}`);
  process.exit(1);
}

const DEVNET_DIR =
  process.env.QC_DEVNET_DIR || (IS_WINDOWS ? "C:\\devnet" : path.join(os.homedir(), "quantumcoin-devnet"));
const RELEASE = process.env.QC_DEVNET_RELEASE || "test-v2.0.74";
const RPC_URL = process.env.QC_RPC_URL || "http://127.0.0.1:18545";
const RPC_PORT = Number(new URL(RPC_URL).port || 18545);
const CHAIN_ID = Number(process.env.QC_CHAIN_ID || 123123);
const RELEASE_BASE = `https://github.com/quantumcoinproject/quantum-coin-go/releases/download/${RELEASE}`;
const ZIP_URL = `${RELEASE_BASE}/${PLATFORM.asset}`;
// e.g. releasehash-windows-devnet-test-v2.0.74.txt
const HASH_URL = `${RELEASE_BASE}/releasehash-${PLATFORM.asset.split(".")[0]}-${RELEASE}.txt`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params = [], timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function isRpcUp() {
  try {
    const chainIdHex = await rpc("eth_chainId");
    return Number(chainIdHex) === CHAIN_ID;
  } catch {
    return false;
  }
}

function findFile(dir, name, depth = 3) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

async function download(url, destination) {
  console.log(`devnet: downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function verifyHash(archiveBuffer) {
  try {
    const response = await fetch(HASH_URL, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const expected = (text.match(/[a-fA-F0-9]{64}/) || [])[0];
    if (!expected) throw new Error("no sha256 found in hash file");
    const actual = require("node:crypto").createHash("sha256").update(archiveBuffer).digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
    }
    console.log("devnet: release hash verified");
  } catch (error) {
    if (String(error).includes("mismatch")) throw error;
    console.warn(`devnet: hash verification skipped (${error.message})`);
  }
}

function extract(archivePath) {
  console.log(`devnet: extracting to ${DEVNET_DIR}`);
  if (archivePath.endsWith(".zip")) {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${DEVNET_DIR}' -Force`,
    ]);
  } else {
    execFileSync("tar", ["-xzf", archivePath, "-C", DEVNET_DIR]);
  }
}

async function ensureInstalled() {
  if (findFile(DEVNET_DIR, PLATFORM.binary, 1)) {
    console.log(`devnet: already installed at ${DEVNET_DIR}`);
    return;
  }
  fs.mkdirSync(DEVNET_DIR, { recursive: true });
  const archivePath = path.join(os.tmpdir(), `${RELEASE}-${PLATFORM.asset}`);
  let archiveBuffer;
  if (fs.existsSync(archivePath)) {
    console.log(`devnet: reusing cached download ${archivePath}`);
    archiveBuffer = fs.readFileSync(archivePath);
  } else {
    archiveBuffer = await download(ZIP_URL, archivePath);
  }
  await verifyHash(archiveBuffer);
  extract(archivePath);
  // If the archive has a single top-level folder, flatten it.
  if (!findFile(DEVNET_DIR, PLATFORM.binary, 0)) {
    const nested = findFile(DEVNET_DIR, PLATFORM.binary, 3);
    if (!nested) throw new Error(`${PLATFORM.binary} not found after extraction`);
    const nestedDir = path.dirname(nested);
    for (const entry of fs.readdirSync(nestedDir)) {
      fs.renameSync(path.join(nestedDir, entry), path.join(DEVNET_DIR, entry));
    }
  }
  if (!IS_WINDOWS) {
    for (const executable of ["dp", "dputil", "relay", "connectvalidator.sh"]) {
      const full = path.join(DEVNET_DIR, executable);
      if (fs.existsSync(full)) fs.chmodSync(full, 0o755);
    }
  }
  console.log("devnet: installed");
}

function launchNode() {
  const logPath = path.join(DEVNET_DIR, "devnet-node.log");
  const logFd = fs.openSync(logPath, "a");
  let command;
  let args;
  if (IS_WINDOWS) {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(DEVNET_DIR, "connectvalidator.ps1"),
      "-RpcPort",
      String(RPC_PORT),
    ];
  } else {
    command = "bash";
    args = [path.join(DEVNET_DIR, "connectvalidator.sh"), String(RPC_PORT)];
  }
  const child = spawn(command, args, {
    cwd: DEVNET_DIR,
    env: process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  console.log(`devnet: launched connectvalidator (pid ${child.pid}), log: ${logPath}`);
}

async function ensureRunning() {
  if (await isRpcUp()) {
    console.log(`devnet: RPC already up at ${RPC_URL}`);
    return;
  }
  launchNode();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await isRpcUp()) {
      console.log("devnet: RPC is up");
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    `devnet RPC did not come up at ${RPC_URL} within 180s; see ${path.join(DEVNET_DIR, "devnet-node.log")}`
  );
}

async function main() {
  const command = process.argv[2] || "ensure";
  if (command !== "ensure") throw new Error(`unknown command: ${command}`);
  await ensureInstalled();
  await ensureRunning();
  console.log("devnet: ready");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
