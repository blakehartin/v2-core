const path = require("node:path");
const {
  qc,
  getContext,
  compileContract,
  deploy,
  send,
  parseEvents,
  expandTo18Decimals,
} = require("./helpers");

const CONTRACTS = path.resolve(__dirname, "..", "contracts");

function factoryArtifact() {
  return compileContract(path.join(CONTRACTS, "QuantumSwapV2Factory.sol"), "QuantumSwapV2Factory");
}

function pairArtifact() {
  return compileContract(path.join(CONTRACTS, "QuantumSwapV2Pair.sol"), "QuantumSwapV2Pair");
}

function erc20Artifact() {
  return compileContract(path.join(CONTRACTS, "test", "ERC20.sol"), "ERC20");
}

async function deployFactory(feeToSetter) {
  const { wallet } = await getContext();
  return deploy(factoryArtifact(), [feeToSetter || wallet.address]);
}

async function deployToken(totalSupply = expandTo18Decimals(10000)) {
  return deploy(erc20Artifact(), [totalSupply]);
}

// Deploys two fresh tokens, creates their pair on `factory`, and returns
// { token0, token1, pair } sorted the same way the factory sorts them.
async function createPairFixture(factory) {
  const { wallet } = await getContext();
  const tokenA = await deployToken();
  const tokenB = await deployToken();
  const receipt = await send(factory.createPair(tokenA.target, tokenB.target, { gasLimit: 6_000_000n }));
  const [event] = parseEvents(receipt, factory, "PairCreated");
  if (!event) throw new Error("PairCreated event not found");
  const pairAddress = event.args[2];
  const pair = new qc.Contract(pairAddress, pairArtifact().abi, wallet);
  const token0Address = await pair.token0();
  const sorted = String(token0Address).toLowerCase() === String(tokenA.target).toLowerCase();
  return {
    token0: sorted ? tokenA : tokenB,
    token1: sorted ? tokenB : tokenA,
    pair,
  };
}

module.exports = { factoryArtifact, pairArtifact, erc20Artifact, deployFactory, deployToken, createPairFixture };
