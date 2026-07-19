// Ported from test/UniswapV2Pair.spec.ts to run against a QuantumCoin devnet.
//
// Differences from the original waffle suite:
// - K-invariant boundary cases (getInputPrice/optimistic) are checked via
//   eth_call instead of sent transactions, so each boundary pair needs no swap tx.
// - The price{0,1}CumulativeLast test cannot mine blocks at chosen timestamps;
//   instead it reconstructs the exact expected accumulator values from the
//   observed on-chain reserve timestamps.
// - The swap:gas snapshot was dropped (QuantumCoin gas schedule differs).
const { test, before } = require("node:test");
const {
  assert,
  qc,
  getContext,
  send,
  expectRevert,
  staticCall,
  scalar,
  parseEvents,
  expandTo18Decimals,
  encodePrice,
  sleep,
  MINIMUM_LIQUIDITY,
  EMPTY_BYTES,
} = require("./helpers");
const { deployFactory, createPairFixture } = require("./fixtures");

const overrides = { gasLimit: 6_000_000n };

let wallet;
let factory;
before(async () => {
  ({ wallet } = await getContext());
  factory = await deployFactory();
});

async function pairFixture(targetFactory = factory) {
  return createPairFixture(targetFactory);
}

async function addLiquidity(fixture, token0Amount, token1Amount) {
  await send(fixture.token0.transfer(fixture.pair.target, token0Amount, overrides));
  await send(fixture.token1.transfer(fixture.pair.target, token1Amount, overrides));
  return send(fixture.pair.mint(wallet.address, overrides));
}

function assertEvent(event, expectedArgs, label) {
  assert.ok(event, `${label} event missing`);
  expectedArgs.forEach((expected, index) => {
    const actual = event.args[index];
    if (typeof expected === "bigint") {
      assert.equal(BigInt(actual), expected, `${label} arg ${index}`);
    } else {
      assert.equal(String(actual).toLowerCase(), String(expected).toLowerCase(), `${label} arg ${index}`);
    }
  });
}

test("mint", async () => {
  const fixture = await pairFixture();
  const { pair, token0, token1 } = fixture;
  const token0Amount = expandTo18Decimals(1);
  const token1Amount = expandTo18Decimals(4);
  await send(token0.transfer(pair.target, token0Amount, overrides));
  await send(token1.transfer(pair.target, token1Amount, overrides));

  const expectedLiquidity = expandTo18Decimals(2);
  const receipt = await send(pair.mint(wallet.address, overrides));

  const transfers = parseEvents(receipt, pair, "Transfer");
  assertEvent(transfers[0], [qc.ZeroAddress, qc.ZeroAddress, MINIMUM_LIQUIDITY], "Transfer(lock)");
  assertEvent(transfers[1], [qc.ZeroAddress, wallet.address, expectedLiquidity - MINIMUM_LIQUIDITY], "Transfer(mint)");
  assertEvent(parseEvents(receipt, pair, "Sync")[0], [token0Amount, token1Amount], "Sync");
  assertEvent(parseEvents(receipt, pair, "Mint")[0], [wallet.address, token0Amount, token1Amount], "Mint");

  assert.equal(scalar(await pair.totalSupply()), expectedLiquidity);
  assert.equal(scalar(await pair.balanceOf(wallet.address)), expectedLiquidity - MINIMUM_LIQUIDITY);
  assert.equal(scalar(await token0.balanceOf(pair.target)), token0Amount);
  assert.equal(scalar(await token1.balanceOf(pair.target)), token1Amount);
  const reserves = await pair.getReserves();
  assert.equal(BigInt(reserves[0]), token0Amount);
  assert.equal(BigInt(reserves[1]), token1Amount);
});

// [swapAmounts ascending, token0Reserve, token1Reserve, expectedOutputs]
// Cases sharing a reserve configuration share one pair; input transfers accumulate.
const swapTestConfigs = [
  { reserves: [5, 10], cases: [[1n, 1662497915624478906n], [2n, 2851015155847869602n]] },
  { reserves: [10, 5], cases: [[1n, 453305446940074565n], [2n, 831248957812239453n]] },
  { reserves: [10, 10], cases: [[1n, 906610893880149131n]] },
  { reserves: [100, 100], cases: [[1n, 987158034397061298n]] },
  { reserves: [1000, 1000], cases: [[1n, 996006981039903216n]] },
];

for (const { reserves, cases } of swapTestConfigs) {
  test(`getInputPrice: reserves (${reserves[0]}, ${reserves[1]})`, async () => {
    const fixture = await pairFixture();
    await addLiquidity(fixture, expandTo18Decimals(reserves[0]), expandTo18Decimals(reserves[1]));
    let transferred = 0n;
    for (const [swapUnits, expectedOutput] of cases) {
      const swapAmount = expandTo18Decimals(swapUnits);
      const delta = swapAmount - transferred;
      if (delta > 0n) {
        await send(fixture.token0.transfer(fixture.pair.target, delta, overrides));
        transferred = swapAmount;
      }
      // QuantumSwapV2: K
      await expectRevert(staticCall(fixture.pair, "swap", [0n, expectedOutput + 1n, wallet.address, EMPTY_BYTES]), "K");
      await staticCall(fixture.pair, "swap", [0n, expectedOutput, wallet.address, EMPTY_BYTES]);
    }
  });
}

// [outputAmount, token0Reserve, token1Reserve, inputAmount]
const optimisticTestConfigs = [
  { reserves: [5, 10], cases: [[997000000000000000n, expandTo18Decimals(1)]] },
  { reserves: [10, 5], cases: [[997000000000000000n, expandTo18Decimals(1)]] },
  {
    reserves: [5, 5],
    cases: [
      [997000000000000000n, expandTo18Decimals(1)], // amountOut = floor(amountIn * .997)
      [expandTo18Decimals(1), 1003009027081243732n], // amountIn = ceiling(amountOut / .997)
    ],
  },
];

for (const { reserves, cases } of optimisticTestConfigs) {
  test(`optimistic: reserves (${reserves[0]}, ${reserves[1]})`, async () => {
    const fixture = await pairFixture();
    await addLiquidity(fixture, expandTo18Decimals(reserves[0]), expandTo18Decimals(reserves[1]));
    let transferred = 0n;
    for (const [outputAmount, inputAmount] of cases) {
      const delta = inputAmount - transferred;
      if (delta > 0n) {
        await send(fixture.token0.transfer(fixture.pair.target, delta, overrides));
        transferred = inputAmount;
      }
      // QuantumSwapV2: K
      await expectRevert(staticCall(fixture.pair, "swap", [outputAmount + 1n, 0n, wallet.address, EMPTY_BYTES]), "K");
      await staticCall(fixture.pair, "swap", [outputAmount, 0n, wallet.address, EMPTY_BYTES]);
    }
  });
}

test("swap:token0", async () => {
  const fixture = await pairFixture();
  const { pair, token0, token1 } = fixture;
  const token0Amount = expandTo18Decimals(5);
  const token1Amount = expandTo18Decimals(10);
  await addLiquidity(fixture, token0Amount, token1Amount);

  const swapAmount = expandTo18Decimals(1);
  const expectedOutputAmount = 1662497915624478906n;
  await send(token0.transfer(pair.target, swapAmount, overrides));
  const receipt = await send(pair.swap(0n, expectedOutputAmount, wallet.address, EMPTY_BYTES, overrides));

  assertEvent(parseEvents(receipt, token1, "Transfer")[0], [pair.target, wallet.address, expectedOutputAmount], "token1 Transfer");
  assertEvent(parseEvents(receipt, pair, "Sync")[0], [token0Amount + swapAmount, token1Amount - expectedOutputAmount], "Sync");
  assertEvent(
    parseEvents(receipt, pair, "Swap")[0],
    [wallet.address, swapAmount, 0n, 0n, expectedOutputAmount, wallet.address],
    "Swap"
  );

  const reserves = await pair.getReserves();
  assert.equal(BigInt(reserves[0]), token0Amount + swapAmount);
  assert.equal(BigInt(reserves[1]), token1Amount - expectedOutputAmount);
  assert.equal(scalar(await token0.balanceOf(pair.target)), token0Amount + swapAmount);
  assert.equal(scalar(await token1.balanceOf(pair.target)), token1Amount - expectedOutputAmount);
  const totalSupplyToken0 = scalar(await token0.totalSupply());
  const totalSupplyToken1 = scalar(await token1.totalSupply());
  assert.equal(scalar(await token0.balanceOf(wallet.address)), totalSupplyToken0 - token0Amount - swapAmount);
  assert.equal(scalar(await token1.balanceOf(wallet.address)), totalSupplyToken1 - token1Amount + expectedOutputAmount);
});

test("swap:token1", async () => {
  const fixture = await pairFixture();
  const { pair, token0, token1 } = fixture;
  const token0Amount = expandTo18Decimals(5);
  const token1Amount = expandTo18Decimals(10);
  await addLiquidity(fixture, token0Amount, token1Amount);

  const swapAmount = expandTo18Decimals(1);
  const expectedOutputAmount = 453305446940074565n;
  await send(token1.transfer(pair.target, swapAmount, overrides));
  const receipt = await send(pair.swap(expectedOutputAmount, 0n, wallet.address, EMPTY_BYTES, overrides));

  assertEvent(parseEvents(receipt, token0, "Transfer")[0], [pair.target, wallet.address, expectedOutputAmount], "token0 Transfer");
  assertEvent(parseEvents(receipt, pair, "Sync")[0], [token0Amount - expectedOutputAmount, token1Amount + swapAmount], "Sync");
  assertEvent(
    parseEvents(receipt, pair, "Swap")[0],
    [wallet.address, 0n, swapAmount, expectedOutputAmount, 0n, wallet.address],
    "Swap"
  );

  const reserves = await pair.getReserves();
  assert.equal(BigInt(reserves[0]), token0Amount - expectedOutputAmount);
  assert.equal(BigInt(reserves[1]), token1Amount + swapAmount);
  assert.equal(scalar(await token0.balanceOf(pair.target)), token0Amount - expectedOutputAmount);
  assert.equal(scalar(await token1.balanceOf(pair.target)), token1Amount + swapAmount);
  const totalSupplyToken0 = scalar(await token0.totalSupply());
  const totalSupplyToken1 = scalar(await token1.totalSupply());
  assert.equal(scalar(await token0.balanceOf(wallet.address)), totalSupplyToken0 - token0Amount + expectedOutputAmount);
  assert.equal(scalar(await token1.balanceOf(wallet.address)), totalSupplyToken1 - token1Amount - swapAmount);
});

test("burn", async () => {
  const fixture = await pairFixture();
  const { pair, token0, token1 } = fixture;
  const token0Amount = expandTo18Decimals(3);
  const token1Amount = expandTo18Decimals(3);
  await addLiquidity(fixture, token0Amount, token1Amount);

  const expectedLiquidity = expandTo18Decimals(3);
  await send(pair.transfer(pair.target, expectedLiquidity - MINIMUM_LIQUIDITY, overrides));
  const receipt = await send(pair.burn(wallet.address, overrides));

  assertEvent(
    parseEvents(receipt, pair, "Transfer")[0],
    [pair.target, qc.ZeroAddress, expectedLiquidity - MINIMUM_LIQUIDITY],
    "Transfer(burn)"
  );
  assertEvent(parseEvents(receipt, token0, "Transfer")[0], [pair.target, wallet.address, token0Amount - 1000n], "token0 Transfer");
  assertEvent(parseEvents(receipt, token1, "Transfer")[0], [pair.target, wallet.address, token1Amount - 1000n], "token1 Transfer");
  assertEvent(parseEvents(receipt, pair, "Sync")[0], [1000n, 1000n], "Sync");
  assertEvent(
    parseEvents(receipt, pair, "Burn")[0],
    [wallet.address, token0Amount - 1000n, token1Amount - 1000n, wallet.address],
    "Burn"
  );

  assert.equal(scalar(await pair.balanceOf(wallet.address)), 0n);
  assert.equal(scalar(await pair.totalSupply()), MINIMUM_LIQUIDITY);
  assert.equal(scalar(await token0.balanceOf(pair.target)), 1000n);
  assert.equal(scalar(await token1.balanceOf(pair.target)), 1000n);
  const totalSupplyToken0 = scalar(await token0.totalSupply());
  const totalSupplyToken1 = scalar(await token1.totalSupply());
  assert.equal(scalar(await token0.balanceOf(wallet.address)), totalSupplyToken0 - 1000n);
  assert.equal(scalar(await token1.balanceOf(wallet.address)), totalSupplyToken1 - 1000n);
});

test("skim", async () => {
  const fixture = await pairFixture();
  const { pair, token0, token1 } = fixture;
  await addLiquidity(fixture, expandTo18Decimals(1), expandTo18Decimals(1));

  const extra = 12345n;
  await send(token0.transfer(pair.target, extra, overrides));
  const balanceBefore = scalar(await token0.balanceOf(wallet.address));
  await send(pair.skim(wallet.address, overrides));

  assert.equal(scalar(await token0.balanceOf(pair.target)), expandTo18Decimals(1));
  assert.equal(scalar(await token1.balanceOf(pair.target)), expandTo18Decimals(1));
  assert.equal(scalar(await token0.balanceOf(wallet.address)), balanceBefore + extra);
});

test("price{0,1}CumulativeLast (exact, reconstructed from observed timestamps)", async () => {
  const fixture = await pairFixture();
  const { pair, token0 } = fixture;
  const token0Amount = expandTo18Decimals(3);
  const token1Amount = expandTo18Decimals(3);
  await addLiquidity(fixture, token0Amount, token1Amount);

  let [reserve0, reserve1, lastTimestamp] = (await pair.getReserves()).map(BigInt);
  let expected0 = 0n;
  let expected1 = 0n;

  async function accumulateAndCheck(action) {
    const priceBefore = encodePrice(reserve0, reserve1);
    await action();
    const [newReserve0, newReserve1, newTimestamp] = (await pair.getReserves()).map(BigInt);
    // _update accumulates old-reserve prices over elapsed time, modulo 2**32 timestamps.
    const elapsed = (newTimestamp - lastTimestamp) & 0xffffffffn;
    expected0 = BigInt.asUintN(256, expected0 + priceBefore[0] * elapsed);
    expected1 = BigInt.asUintN(256, expected1 + priceBefore[1] * elapsed);
    reserve0 = newReserve0;
    reserve1 = newReserve1;
    lastTimestamp = newTimestamp;
    assert.equal(scalar(await pair.price0CumulativeLast()), expected0);
    assert.equal(scalar(await pair.price1CumulativeLast()), expected1);
  }

  // 1. sync after some time passes
  await sleep(3000);
  await accumulateAndCheck(() => send(pair.sync(overrides)));

  // 2. swap to a new price (3,3) -> (6,2)
  await send(token0.transfer(pair.target, expandTo18Decimals(3), overrides));
  await accumulateAndCheck(() => send(pair.swap(0n, expandTo18Decimals(1), wallet.address, EMPTY_BYTES, overrides)));
  assert.equal(reserve0, expandTo18Decimals(6));
  assert.equal(reserve1, expandTo18Decimals(2));

  // 3. sync again at the new price
  await sleep(3000);
  await accumulateAndCheck(() => send(pair.sync(overrides)));
});

test("feeTo:off", async () => {
  const fixture = await pairFixture();
  const { pair, token1 } = fixture;
  const amount = expandTo18Decimals(1000);
  await addLiquidity(fixture, amount, amount);

  const swapAmount = expandTo18Decimals(1);
  const expectedOutputAmount = 996006981039903216n;
  await send(token1.transfer(pair.target, swapAmount, overrides));
  await send(pair.swap(expectedOutputAmount, 0n, wallet.address, EMPTY_BYTES, overrides));

  const expectedLiquidity = expandTo18Decimals(1000);
  await send(pair.transfer(pair.target, expectedLiquidity - MINIMUM_LIQUIDITY, overrides));
  await send(pair.burn(wallet.address, overrides));
  assert.equal(scalar(await pair.totalSupply()), MINIMUM_LIQUIDITY);
});

test("feeTo:on", async () => {
  // Separate factory so the fee switch does not affect other tests' pairs.
  const feeFactory = await deployFactory();
  const feeRecipient = "0x00000000000000000000000000000000000000000000000000000000feefee01";
  await send(feeFactory.setFeeTo(feeRecipient, overrides));

  const fixture = await pairFixture(feeFactory);
  const { pair, token0, token1 } = fixture;
  const amount = expandTo18Decimals(1000);
  await addLiquidity(fixture, amount, amount);

  const swapAmount = expandTo18Decimals(1);
  const expectedOutputAmount = 996006981039903216n;
  await send(token1.transfer(pair.target, swapAmount, overrides));
  await send(pair.swap(expectedOutputAmount, 0n, wallet.address, EMPTY_BYTES, overrides));

  const expectedLiquidity = expandTo18Decimals(1000);
  await send(pair.transfer(pair.target, expectedLiquidity - MINIMUM_LIQUIDITY, overrides));
  await send(pair.burn(wallet.address, overrides));

  assert.equal(scalar(await pair.totalSupply()), MINIMUM_LIQUIDITY + 249750499251388n);
  assert.equal(scalar(await pair.balanceOf(feeRecipient)), 249750499251388n);
  // 1000 wei is the locked MINIMUM_LIQUIDITY portion; fee shares on top.
  assert.equal(scalar(await token0.balanceOf(pair.target)), 1000n + 249501683697445n);
  assert.equal(scalar(await token1.balanceOf(pair.target)), 1000n + 250000187312969n);
});
