// Builds the production V2 artifacts (WQ, factory, pair, router02) with
// @quantumcoin/solc, generates Go bindings with abigen2, and writes a
// reproducibility manifest (source pins + artifact SHA-256 hashes) into
// quantumswap-deploy. Replaces the former build-production.ps1.
//
// Usage: node scripts/build-production.js
//   ABIGEN_PATH overrides the abigen2 binary (default C:\build\abigen2.exe).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const qcSolc = require("./qc-solc");

const core = path.resolve(__dirname, "..");
const quantumswap = path.resolve(core, "..");
const github = path.resolve(quantumswap, "..");
const periphery = path.join(quantumswap, "v2-periphery");
const deploy = path.join(quantumswap, "quantumswap-deploy");
const wq = path.join(github, "wq");
const lib = path.join(github, "solidity-lib");

const abigen =
  process.env.ABIGEN_PATH || (process.platform === "win32" ? "C:\\build\\abigen2.exe" : "abigen2");

for (const p of [periphery, deploy, wq, lib]) {
  if (!fs.existsSync(p)) throw new Error(`Required path does not exist: ${p}`);
}

const wqOut = path.join(deploy, "contracts", "wq");
const coreOut = path.join(deploy, "contracts", "corev2");
const routerOut = path.join(deploy, "contracts", "v2swaprouter");
const pairOut = path.join(deploy, "contracts", "pairv2");

// --- compile ---
const wqOutput = qcSolc.compile([path.join(wq, "wrappedq.sol")]);
qcSolc.writeArtifacts(wqOutput, wqOut, ["WQ"]);

const coreOutput = qcSolc.compile([path.join(core, "contracts", "QuantumSwapV2Factory.sol")]);
qcSolc.writeArtifacts(coreOutput, coreOut, ["QuantumSwapV2Factory", "QuantumSwapV2Pair"]);

const routerOutput = qcSolc.compile(
  [path.join(periphery, "contracts", "QuantumSwapV2Router02.sol")],
  [`@quantumswap/v2-core=${core}`, `@quantumcoin/solidity-lib=${lib}`]
);
qcSolc.writeArtifacts(routerOutput, routerOut, ["QuantumSwapV2Router02"]);

// --- Go bindings ---
function runAbigen(binDir, name, pkg, outFile) {
  execFileSync(
    abigen,
    [
      "--bin", path.join(binDir, `${name}.bin`),
      "--abi", path.join(binDir, `${name}.abi`),
      "--pkg", pkg,
      "--out", outFile,
    ],
    { stdio: "inherit" }
  );
}
fs.mkdirSync(pairOut, { recursive: true });
runAbigen(wqOut, "WQ", "wq", path.join(wqOut, "wq.go"));
runAbigen(coreOut, "QuantumSwapV2Factory", "corev2", path.join(coreOut, "QuantumSwapV2Factory.go"));
runAbigen(routerOut, "QuantumSwapV2Router02", "v2swaprouter", path.join(routerOut, "QuantumSwapV2Router02.go"));
runAbigen(coreOut, "QuantumSwapV2Pair", "pairv2", path.join(pairOut, "QuantumSwapV2Pair.go"));

// --- reproducibility manifest ---
function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

const repositories = { wq, solidityLib: lib, v2Core: core, v2Periphery: periphery };
const sourcePins = {};
for (const [key, repo] of Object.entries(repositories)) {
  const status = git(repo, "status", "--porcelain", "--untracked-files=no");
  sourcePins[key] = {
    commit: git(repo, "rev-parse", "HEAD"),
    trackedFilesClean: status.length === 0,
  };
}

const artifactPaths = [];
for (const [dir, name] of [
  [wqOut, "WQ"],
  [coreOut, "QuantumSwapV2Factory"],
  [coreOut, "QuantumSwapV2Pair"],
  [routerOut, "QuantumSwapV2Router02"],
]) {
  for (const ext of ["bin", "bin-runtime", "abi"]) {
    artifactPaths.push(path.join(dir, `${name}.${ext}`));
  }
}

const artifactSha256 = {};
for (const artifact of artifactPaths) {
  const relative = path.relative(deploy, artifact).split(path.sep).join("/");
  artifactSha256[relative] = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
}

const manifest = {
  compiler: qcSolc.compilerVersion(),
  compilerPackage: "@quantumcoin/solc",
  optimizer: { enabled: true, runs: 999999 },
  metadataHash: "none",
  sourcePins,
  artifactSha256,
};

const manifestPath = path.join(deploy, "contracts", "v2-production-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Wrote reproducible V2 artifacts and manifest to ${path.join(deploy, "contracts")}`);
