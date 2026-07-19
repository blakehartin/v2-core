// Ported from test/UniswapV2Factory.spec.ts to run against a QuantumCoin devnet.
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
  newFundedWallet,
} = require("./helpers");
const { deployFactory, pairArtifact } = require("./fixtures");

// 32-byte QuantumCoin addresses (Ethereum used 20-byte test addresses here).
const TEST_ADDRESSES = [
  "0x1000000000000000000000000000000000000000000000000000000000000000",
  "0x2000000000000000000000000000000000000000000000000000000000000000",
];

let wallet;
before(async () => {
  ({ wallet } = await getContext());
});

test("feeTo, feeToSetter, allPairsLength", async () => {
  const factory = await deployFactory();
  assert.equal(String(await factory.feeTo()).toLowerCase(), qc.ZeroAddress.toLowerCase());
  assert.equal(String(await factory.feeToSetter()).toLowerCase(), wallet.address.toLowerCase());
  assert.equal(scalar(await factory.allPairsLength()), 0n);
});

async function createPairChecks(factory, tokens) {
  const initCodeHash = String(await factory.INIT_CODE_HASH());
  const salt = qc.keccak256(qc.concat([TEST_ADDRESSES[0], TEST_ADDRESSES[1]]));
  const create2Address = qc.getCreate2Address(factory.target, salt, initCodeHash);

  const receipt = await send(factory.createPair(tokens[0], tokens[1], { gasLimit: 6_000_000n }));
  const [event] = parseEvents(receipt, factory, "PairCreated");
  assert.ok(event, "PairCreated event missing");
  assert.equal(String(event.args[0]).toLowerCase(), TEST_ADDRESSES[0].toLowerCase());
  assert.equal(String(event.args[1]).toLowerCase(), TEST_ADDRESSES[1].toLowerCase());
  assert.equal(String(event.args[2]).toLowerCase(), create2Address.toLowerCase());
  assert.equal(BigInt(event.args[3]), 1n);

  // QuantumSwapV2: PAIR_EXISTS (both orderings), verified via eth_call.
  await expectRevert(staticCall(factory, "createPair", [tokens[0], tokens[1]]), "PAIR_EXISTS");
  await expectRevert(staticCall(factory, "createPair", [tokens[1], tokens[0]]), "PAIR_EXISTS");

  assert.equal(String(await factory.getPair(tokens[0], tokens[1])).toLowerCase(), create2Address.toLowerCase());
  assert.equal(String(await factory.getPair(tokens[1], tokens[0])).toLowerCase(), create2Address.toLowerCase());
  assert.equal(String(await factory.allPairs(0)).toLowerCase(), create2Address.toLowerCase());
  assert.equal(scalar(await factory.allPairsLength()), 1n);

  const pair = new qc.Contract(create2Address, pairArtifact().abi, wallet);
  assert.equal(String(await pair.factory()).toLowerCase(), String(factory.target).toLowerCase());
  assert.equal(String(await pair.token0()).toLowerCase(), TEST_ADDRESSES[0].toLowerCase());
  assert.equal(String(await pair.token1()).toLowerCase(), TEST_ADDRESSES[1].toLowerCase());
}

test("createPair", async () => {
  const factory = await deployFactory();
  await createPairChecks(factory, TEST_ADDRESSES);
});

test("createPair:reverse", async () => {
  const factory = await deployFactory();
  await createPairChecks(factory, [...TEST_ADDRESSES].reverse());
});

test("createPair:invalid arguments", async () => {
  const factory = await deployFactory();
  await expectRevert(staticCall(factory, "createPair", [TEST_ADDRESSES[0], TEST_ADDRESSES[0]]), "IDENTICAL_ADDRESSES");
  await expectRevert(staticCall(factory, "createPair", [qc.ZeroAddress, TEST_ADDRESSES[0]]), "ZERO_ADDRESS");
});

test("setFeeTo / setFeeToSetter permissions", async () => {
  const factory = await deployFactory();
  const other = await newFundedWallet();

  // QuantumSwapV2: FORBIDDEN when called by non-feeToSetter.
  await expectRevert(staticCall(factory, "setFeeTo", [other.address], { from: other.address }), "FORBIDDEN");
  await send(factory.setFeeTo(wallet.address, { gasLimit: 200_000n }));
  assert.equal(String(await factory.feeTo()).toLowerCase(), wallet.address.toLowerCase());

  await expectRevert(staticCall(factory, "setFeeToSetter", [other.address], { from: other.address }), "FORBIDDEN");
  await send(factory.setFeeToSetter(other.address, { gasLimit: 200_000n }));
  assert.equal(String(await factory.feeToSetter()).toLowerCase(), other.address.toLowerCase());
  await expectRevert(staticCall(factory, "setFeeToSetter", [wallet.address], { from: wallet.address }), "FORBIDDEN");
});
