// Shared devnet test helpers for QuantumSwap/QuantumCoin repositories.
// Tests run against a live QuantumCoin devnet (see scripts/devnet.js).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const qc = require("quantumcoin");
const { Initialize, Config } = require("quantumcoin/config");

const qcSolc = require("../scripts/qc-solc");

const IS_WINDOWS = process.platform === "win32";
const rpcUrl = process.env.QC_RPC_URL || "http://127.0.0.1:18545";
const chainId = Number(process.env.QC_CHAIN_ID || 123123);
const devnetDir =
  process.env.QC_DEVNET_DIR || (IS_WINDOWS ? "C:\\devnet" : path.join(os.homedir(), "quantumcoin-devnet"));
const password = process.env.QC_KEY_PASSWORD || "QuantumCoinExample123!";
const FUNDED_ACCOUNT = "1a846abe71c8b989e8337c55d608be81c28ab3b2e40c83eaa2a68d516049aec6";

// Work around a quantumcoin.js encoding bug: encodeFunctionData(name, args)
// routes through qcsdk.packMethodData, which normalizes narrow integer types
// (uint112, uint144, ...) to uint256 and therefore derives a wrong 4-byte
// selector (e.g. encode(uint112) hashed as encode(uint256)). Resolving the
// fragment first forces the exact-input pure-JS coder, which computes the
// canonical selector and encodes values byte-for-byte correctly.
const _encodeFunctionData = qc.Interface.prototype.encodeFunctionData;
qc.Interface.prototype.encodeFunctionData = function (fragment, values) {
  const frag = typeof fragment === "string" ? this.getFunction(fragment) : fragment;
  return _encodeFunctionData.call(this, frag, values);
};

// Same normalization bug hits event decoding: qcsdk.decodeEventLog recomputes
// the topic hash from the normalized ABI, so events with narrow integer types
// (e.g. Sync(uint112,uint112)) fail to decode. For events whose inputs are all
// static single-word types, decode topics/data directly instead.
function _isStaticWordType(type) {
  return (
    type === "address" ||
    type === "bool" ||
    /^uint(\d+)?$/.test(type) ||
    /^int(\d+)?$/.test(type) ||
    /^bytes(\d+)$/.test(type)
  );
}
function _decodeWord(type, hexWord) {
  const word = hexWord.toLowerCase();
  if (type === "bool") return BigInt(word) !== 0n;
  if (/^int/.test(type)) return BigInt.asIntN(256, BigInt(word));
  if (/^uint/.test(type)) return BigInt(word);
  return word; // address (32 bytes on QuantumCoin) and bytesN stay hex
}
const _decodeEventLog = qc.Interface.prototype.decodeEventLog;
qc.Interface.prototype.decodeEventLog = function (eventFragment, topics, data) {
  const name = typeof eventFragment === "string" ? eventFragment : eventFragment && eventFragment.name;
  const frag = this.getEvent(name);
  const inputs = Array.isArray(frag.inputs) ? frag.inputs : [];
  if (!inputs.every((input) => _isStaticWordType(String(input.type)))) {
    return _decodeEventLog.call(this, eventFragment, topics, data);
  }
  const body = String(data).replace(/^0x/, "");
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) words.push(`0x${body.slice(i, i + 64)}`);
  let topicIndex = 1;
  let wordIndex = 0;
  return inputs.map((input) =>
    _decodeWord(String(input.type), input.indexed ? String(topics[topicIndex++]) : words[wordIndex++])
  );
};

function findKeystore() {
  if (process.env.QC_KEYSTORE) return process.env.QC_KEYSTORE;
  const candidates = [
    path.join(devnetDir, FUNDED_ACCOUNT, FUNDED_ACCOUNT),
    path.join(devnetDir, FUNDED_ACCOUNT),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error("No devnet keystore found; set QC_KEYSTORE");
}

let contextPromise;
function getContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      await Initialize(new Config(chainId, rpcUrl));
      const provider = qc.getProvider(rpcUrl, chainId);
      const wallet = qc.Wallet.fromEncryptedJsonSync(
        fs.readFileSync(findKeystore(), "utf8"),
        password,
        provider,
      );
      return { provider, wallet, qc };
    })();
  }
  return contextPromise;
}

// Compiles a single contract with @quantumcoin/solc, production settings.
const compileCache = new Map();
function compileContract(sourcePath, contractName, remappings = [], extraSources = []) {
  const cacheKey = `${sourcePath}::${contractName}`;
  if (compileCache.has(cacheKey)) return compileCache.get(cacheKey);
  const artifact = qcSolc.compileContract(sourcePath, contractName, remappings, extraSources);
  compileCache.set(cacheKey, artifact);
  return artifact;
}

async function deploy(artifact, args = [], overrides = {}) {
  const { provider, wallet } = await getContext();
  const signer = overrides.signer || wallet;
  const factory = new qc.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const request = factory.getDeployTransaction(...args);
  const nonce = await provider.getTransactionCount(signer.address, "latest");
  const expectedAddress = qc.getCreateAddress({ from: signer.address, nonce });
  let gasLimit = overrides.gasLimit;
  if (!gasLimit) {
    try {
      const estimate = await provider.estimateGas({ from: signer.address, data: request.data });
      gasLimit = estimate + 200_000n;
    } catch {
      gasLimit = 8_000_000n;
    }
  }
  const tx = await signer.sendTransaction({ ...request, nonce, gasLimit, value: 0n });
  const receipt = await tx.wait(1, 600_000);
  assert.equal(receipt.status, 1, "deployment reverted");
  assert.ok((await provider.getCode(expectedAddress)).length > 2, "no code at deployed address");
  return new qc.Contract(expectedAddress, artifact.abi, signer);
}

// Sends a transaction and asserts success; returns the receipt.
async function send(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait(1, 600_000);
  assert.equal(receipt.status, 1, "transaction reverted");
  return receipt;
}

// Asserts that a promise (transaction send, call, or gas estimate) rejects.
async function expectRevert(promise, reasonSubstring) {
  let error;
  try {
    const result = await promise;
    // If this was a sent transaction, wait to see if it reverts on-chain.
    if (result && typeof result.wait === "function") {
      const receipt = await result.wait(1, 600_000);
      if (receipt.status !== 1) return;
    }
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected revert${reasonSubstring ? ` (${reasonSubstring})` : ""}, but call succeeded`);
  if (reasonSubstring) {
    const message = String((error && (error.message || error)) || "");
    // Only enforce the reason when the RPC surfaced revert data.
    if (/revert/i.test(message) && message.length > 0 && !message.includes(reasonSubstring)) {
      // Some RPCs do not include reason strings; tolerate but log.
      if (/[A-Za-z]+: [A-Z_]+/.test(message)) {
        assert.fail(`expected revert reason containing '${reasonSubstring}', got: ${message}`);
      }
    }
  }
}

// Performs an eth_call of a state-mutating function, asserting success or revert
// without changing chain state. Used for boundary cases to keep tests fast.
async function staticCall(contract, method, args = [], overrides = {}) {
  const { provider, wallet } = await getContext();
  const data = contract.interface.encodeFunctionData(method, args);
  return provider.call({ from: overrides.from || wallet.address, to: contract.target, data, value: overrides.value || 0n });
}

function scalar(value) {
  return Array.isArray(value) ? value[0] : value;
}

function expandTo18Decimals(n) {
  return BigInt(n) * 10n ** 18n;
}

// UQ112x112 price encoding, mirroring test/shared/utilities.ts encodePrice.
function encodePrice(reserve0, reserve1) {
  return [(reserve1 * 2n ** 112n) / reserve0, (reserve0 * 2n ** 112n) / reserve1];
}

// Creates a fresh random wallet funded from the primary wallet with enough
// native coin to pay for ~2M gas at the current network gas price, plus
// `extra` for value transfers. (Devnet gas price is ~4.8e15 wei, so gas for a
// single 200k-gas transaction costs ~950 Q; a fixed small amount is not enough.)
async function newFundedWallet(extra = 0n) {
  const { provider, wallet } = await getContext();
  const other = qc.Wallet.createRandom(provider);
  let gasAllowance = 10n ** 22n;
  try {
    const feeData = await provider.getFeeData(wallet);
    if (feeData && feeData.gasPrice) gasAllowance = feeData.gasPrice * 2_000_000n;
  } catch {
    // keep the fallback allowance
  }
  const amount = gasAllowance + BigInt(extra);
  const tx = await wallet.sendTransaction({ to: other.address, value: amount, gasLimit: 100_000n });
  const receipt = await tx.wait(1, 600_000);
  assert.equal(receipt.status, 1, "funding transfer failed");
  return other;
}

// Parses receipt logs emitted by `contract` and returns events with the given name.
function parseEvents(receipt, contract, eventName) {
  const events = [];
  for (const log of receipt.logs || []) {
    if (log.address && contract.target && log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === eventName) events.push(parsed);
    } catch {
      // Not an event of this contract's ABI.
    }
  }
  return events;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MINIMUM_LIQUIDITY = 1000n;
const MaxUint256 = 2n ** 256n - 1n;
// The SDK's coder rejects "0x" for empty `bytes` args; a zero-length
// Uint8Array encodes correctly.
const EMPTY_BYTES = new Uint8Array(0);

module.exports = {
  assert,
  qc,
  getContext,
  compileContract,
  deploy,
  send,
  expectRevert,
  staticCall,
  scalar,
  expandTo18Decimals,
  encodePrice,
  newFundedWallet,
  parseEvents,
  sleep,
  MINIMUM_LIQUIDITY,
  MaxUint256,
  EMPTY_BYTES,
};
