const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const qc = require("quantumcoin");
const { Initialize, Config } = require("quantumcoin/config");
const qcSolc = require("./qc-solc");

const rpcUrl = process.env.QC_RPC_URL || "http://127.0.0.1:18545";
const chainId = Number(process.env.QC_CHAIN_ID || 123123);
const password = process.env.QC_KEY_PASSWORD || "QuantumCoinExample123!";

const coreRoot = path.resolve(__dirname, "..");
const quantumswapRoot = path.resolve(coreRoot, "..");
const githubRoot = path.resolve(quantumswapRoot, "..");
const deployRoot = path.join(quantumswapRoot, "quantumswap-deploy");
const peripheryRoot = path.join(quantumswapRoot, "v2-periphery");

const FUNDED_ACCOUNT = "1a846abe71c8b989e8337c55d608be81c28ab3b2e40c83eaa2a68d516049aec6";
function findKeystore() {
  if (process.env.QC_KEYSTORE) return process.env.QC_KEYSTORE;
  const devnetDir =
    process.env.QC_DEVNET_DIR ||
    (process.platform === "win32" ? "C:\\devnet" : path.join(require("node:os").homedir(), "quantumcoin-devnet"));
  for (const candidate of [path.join(devnetDir, FUNDED_ACCOUNT, FUNDED_ACCOUNT), path.join(devnetDir, FUNDED_ACCOUNT)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error("No devnet keystore found; set QC_KEYSTORE");
}
const keystore = findKeystore();

function readArtifact(relativeDirectory, name) {
  const directory = path.join(deployRoot, "contracts", relativeDirectory);
  return {
    abi: JSON.parse(fs.readFileSync(path.join(directory, `${name}.abi`), "utf8")),
    bytecode: `0x${fs.readFileSync(path.join(directory, `${name}.bin`), "utf8").trim()}`,
  };
}

function compileContract(source, contractName, extraSources = []) {
  return qcSolc.compileContract(source, contractName, [
    `@quantumswap/v2-core=${coreRoot}`,
    `@quantumcoin/solidity-lib=${path.join(githubRoot, "solidity-lib")}`,
  ], extraSources);
}

async function deploy(wallet, provider, artifact, args = []) {
  const factory = new qc.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const request = factory.getDeployTransaction(...args);
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const expectedAddress = qc.getCreateAddress({ from: wallet.address, nonce });
  const estimate = await provider.estimateGas({ from: wallet.address, data: request.data });
  const tx = await wallet.sendTransaction({
    ...request,
    nonce,
    gasLimit: estimate + 50_000n,
    value: 0n,
  });
  const receipt = await tx.wait(1, 600_000);
  assert.equal(receipt.status, 1);
  assert.ok((await provider.getCode(expectedAddress)).length > 2);
  return new qc.Contract(expectedAddress, artifact.abi, wallet);
}

async function send(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait(1, 600_000);
  assert.equal(receipt.status, 1);
  return receipt;
}

function scalar(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function main() {
  await Initialize(new Config(chainId, rpcUrl));
  const provider = qc.getProvider(rpcUrl, chainId);
  const wallet = qc.Wallet.fromEncryptedJsonSync(fs.readFileSync(keystore, "utf8"), password, provider);

  const wqArtifact = readArtifact("wq", "WQ");
  const factoryArtifact = readArtifact("corev2", "QuantumSwapV2Factory");
  const routerArtifact = readArtifact("v2swaprouter", "QuantumSwapV2Router02");
  const pairAbi = JSON.parse(
    fs.readFileSync(path.join(deployRoot, "contracts", "corev2", "QuantumSwapV2Pair.abi"), "utf8"),
  );
  const tokenArtifact = compileContract(path.join(coreRoot, "contracts", "test", "ERC20.sol"), "ERC20");
  const addressArtifact = compileContract(
    path.join(peripheryRoot, "contracts", "test", "QuantumAddressTest.sol"),
    "QuantumAddressTest",
  );

  const wq = await deploy(wallet, provider, wqArtifact);
  const factory = await deploy(wallet, provider, factoryArtifact, [wallet.address]);
  const router = await deploy(wallet, provider, routerArtifact, [factory.target, wq.target]);
  const supply = 10_000n * 10n ** 18n;
  const tokenA = await deploy(wallet, provider, tokenArtifact, [supply]);
  const tokenB = await deploy(wallet, provider, tokenArtifact, [supply]);
  const addressHarness = await deploy(wallet, provider, addressArtifact);

  assert.equal(scalar(await addressHarness.packedAddressLength()), 32n);
  assert.equal(scalar(await addressHarness.packedPairLength(tokenA.target, tokenB.target)), 64n);

  await send(wq.deposit({ value: 10n ** 18n, gasLimit: 300_000n }));
  assert.equal(scalar(await wq.balanceOf(wallet.address)), 10n ** 18n);
  await send(wq.withdraw(10n ** 17n, { gasLimit: 300_000n }));
  assert.equal(scalar(await wq.balanceOf(wallet.address)), 9n * 10n ** 17n);

  const liquidityAmount = 100n * 10n ** 18n;
  await send(factory.setFeeTo(tokenA.target, { gasLimit: 300_000n }));
  await send(tokenA.approve(router.target, liquidityAmount, { gasLimit: 300_000n }));
  await send(tokenB.approve(router.target, liquidityAmount, { gasLimit: 300_000n }));
  const deadline = (1n << 64n) - 1n;
  await send(
    router.addLiquidity(
      tokenA.target,
      tokenB.target,
      liquidityAmount,
      liquidityAmount,
      1n,
      1n,
      wallet.address,
      deadline,
      { gasLimit: 5_000_000n },
    ),
  );

  const pairAddress = scalar(await factory.getPair(tokenA.target, tokenB.target));
  assert.notEqual(pairAddress, qc.ZeroAddress);
  assert.equal(
    scalar(await addressHarness.pairFor(factory.target, tokenA.target, tokenB.target)),
    pairAddress,
  );
  const pair = new qc.Contract(pairAddress, pairAbi, wallet);
  const reservesBefore = await pair.getReserves();
  assert.ok(reservesBefore[0] > 0n && reservesBefore[1] > 0n);
  assert.equal(scalar(await pair.name()), "QuantumSwap V2");
  assert.equal(scalar(await pair.symbol()), "QSWAP-V2");

  const pairToken0 = scalar(await pair.token0());
  const reserveIn = pairToken0.toLowerCase() === tokenA.target.toLowerCase() ? reservesBefore[0] : reservesBefore[1];
  const reserveOut = pairToken0.toLowerCase() === tokenA.target.toLowerCase() ? reservesBefore[1] : reservesBefore[0];
  for (let i = 1n; i <= 10n; i++) {
    const amountIn = i * 10n ** 16n;
    const expectedOut = (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);
    const actualOut = scalar(await router.getAmountOut(amountIn, reserveIn, reserveOut));
    assert.equal(actualOut, expectedOut);
    const adjustedIn = (reserveIn + amountIn) * 1000n - amountIn * 3n;
    const adjustedOut = (reserveOut - actualOut) * 1000n;
    assert.ok(adjustedIn * adjustedOut >= reserveIn * reserveOut * 1000n ** 2n);
  }

  const swapAmount = 10n ** 18n;
  await send(tokenA.approve(router.target, swapAmount, { gasLimit: 300_000n }));
  const quoted = scalar(await router.getAmountsOut(swapAmount, [tokenA.target, tokenB.target]));
  assert.ok(quoted[1] > 0n);
  const expiredOrSlippageData = router.interface.encodeFunctionData("swapExactTokensForTokens", [
    swapAmount,
    quoted[1] + 1n,
    [tokenA.target, tokenB.target],
    wallet.address,
    deadline,
  ]);
  await assert.rejects(
    provider.call({ from: wallet.address, to: router.target, data: expiredOrSlippageData }),
  );
  await send(
    router.swapExactTokensForTokens(
      swapAmount,
      quoted[1],
      [tokenA.target, tokenB.target],
      wallet.address,
      deadline,
      { gasLimit: 1_500_000n },
    ),
  );
  const reservesAfter = await pair.getReserves();
  assert.notDeepEqual(reservesAfter.slice(0, 2), reservesBefore.slice(0, 2));
  assert.ok(scalar(await pair.price0CumulativeLast()) > 0n);
  assert.ok(scalar(await pair.price1CumulativeLast()) > 0n);

  const followupLiquidity = 10n ** 18n;
  await send(tokenA.approve(router.target, followupLiquidity, { gasLimit: 300_000n }));
  await send(tokenB.approve(router.target, followupLiquidity, { gasLimit: 300_000n }));
  await send(
    router.addLiquidity(
      tokenA.target,
      tokenB.target,
      followupLiquidity,
      followupLiquidity,
      1n,
      1n,
      wallet.address,
      deadline,
      { gasLimit: 2_000_000n },
    ),
  );
  assert.ok(scalar(await pair.balanceOf(tokenA.target)) > 0n);

  console.log(
    JSON.stringify(
      {
        wallet: wallet.address,
        wq: wq.target,
        factory: factory.target,
        router: router.target,
        tokenA: tokenA.target,
        tokenB: tokenB.target,
        pair: pairAddress,
        packedAddressBytes: 32,
        liquidityAdded: true,
        swapSucceeded: true,
        wqDepositWithdraw: true,
        invariantCases: 10,
        slippageReverted: true,
        protocolFeeMinted: true,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
