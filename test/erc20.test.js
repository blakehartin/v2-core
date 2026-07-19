// Ported from test/UniswapV2ERC20.spec.ts to run against a QuantumCoin devnet.
// The permit/DOMAIN_SEPARATOR tests were dropped: QuantumCoin has no ecrecover,
// so permit was removed from the contract itself.
const { test, before } = require("node:test");
const {
  assert,
  getContext,
  send,
  expectRevert,
  staticCall,
  scalar,
  parseEvents,
  expandTo18Decimals,
  newFundedWallet,
  MaxUint256,
} = require("./helpers");
const { deployToken } = require("./fixtures");

const TOTAL_SUPPLY = expandTo18Decimals(10000);
const TEST_AMOUNT = expandTo18Decimals(10);

let wallet;
let other;
before(async () => {
  ({ wallet } = await getContext());
  other = await newFundedWallet(expandTo18Decimals(1));
});

test("name, symbol, decimals, totalSupply, balanceOf", async () => {
  const token = await deployToken(TOTAL_SUPPLY);
  assert.equal(scalar(await token.name()), "QuantumSwap V2");
  assert.equal(scalar(await token.symbol()), "QSWAP-V2");
  assert.equal(BigInt(scalar(await token.decimals())), 18n);
  assert.equal(scalar(await token.totalSupply()), TOTAL_SUPPLY);
  assert.equal(scalar(await token.balanceOf(wallet.address)), TOTAL_SUPPLY);
});

test("approve", async () => {
  const token = await deployToken(TOTAL_SUPPLY);
  const receipt = await send(token.approve(other.address, TEST_AMOUNT, { gasLimit: 200_000n }));
  const [approval] = parseEvents(receipt, token, "Approval");
  assert.ok(approval, "Approval event missing");
  assert.equal(String(approval.args[0]).toLowerCase(), wallet.address.toLowerCase());
  assert.equal(String(approval.args[1]).toLowerCase(), other.address.toLowerCase());
  assert.equal(BigInt(approval.args[2]), TEST_AMOUNT);
  assert.equal(scalar(await token.allowance(wallet.address, other.address)), TEST_AMOUNT);
});

test("transfer", async () => {
  const token = await deployToken(TOTAL_SUPPLY);
  const receipt = await send(token.transfer(other.address, TEST_AMOUNT, { gasLimit: 200_000n }));
  const [transfer] = parseEvents(receipt, token, "Transfer");
  assert.ok(transfer, "Transfer event missing");
  assert.equal(String(transfer.args[0]).toLowerCase(), wallet.address.toLowerCase());
  assert.equal(String(transfer.args[1]).toLowerCase(), other.address.toLowerCase());
  assert.equal(BigInt(transfer.args[2]), TEST_AMOUNT);
  assert.equal(scalar(await token.balanceOf(wallet.address)), TOTAL_SUPPLY - TEST_AMOUNT);
  assert.equal(scalar(await token.balanceOf(other.address)), TEST_AMOUNT);

  // transfer:fail (ds-math-sub-underflow), checked via eth_call.
  await expectRevert(staticCall(token, "transfer", [other.address, TOTAL_SUPPLY + 1n]));
  await expectRevert(staticCall(token, "transfer", [wallet.address, TEST_AMOUNT + 1n], { from: other.address }));
});

test("transferFrom", async () => {
  const token = await deployToken(TOTAL_SUPPLY);
  await send(token.approve(other.address, TEST_AMOUNT, { gasLimit: 200_000n }));
  const receipt = await send(
    token.connect(other).transferFrom(wallet.address, other.address, TEST_AMOUNT, { gasLimit: 200_000n })
  );
  const [transfer] = parseEvents(receipt, token, "Transfer");
  assert.ok(transfer, "Transfer event missing");
  assert.equal(String(transfer.args[0]).toLowerCase(), wallet.address.toLowerCase());
  assert.equal(String(transfer.args[1]).toLowerCase(), other.address.toLowerCase());
  assert.equal(BigInt(transfer.args[2]), TEST_AMOUNT);
  assert.equal(scalar(await token.allowance(wallet.address, other.address)), 0n);
  assert.equal(scalar(await token.balanceOf(wallet.address)), TOTAL_SUPPLY - TEST_AMOUNT);
  assert.equal(scalar(await token.balanceOf(other.address)), TEST_AMOUNT);
});

test("transferFrom:max", async () => {
  const token = await deployToken(TOTAL_SUPPLY);
  await send(token.approve(other.address, MaxUint256, { gasLimit: 200_000n }));
  await send(token.connect(other).transferFrom(wallet.address, other.address, TEST_AMOUNT, { gasLimit: 200_000n }));
  assert.equal(scalar(await token.allowance(wallet.address, other.address)), MaxUint256);
  assert.equal(scalar(await token.balanceOf(wallet.address)), TOTAL_SUPPLY - TEST_AMOUNT);
  assert.equal(scalar(await token.balanceOf(other.address)), TEST_AMOUNT);
});
