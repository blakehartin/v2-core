# QuantumSwap V2 Core

Core contracts for the QuantumSwap V2 protocol on the QuantumCoin blockchain.

This is a modified fork of [Uniswap V2 core](https://github.com/Uniswap/v2-core) (GPL-3.0-or-later),
adapted for QuantumCoin: Solidity 0.7.6, 32-byte addresses, no `ecrecover`/permit.

# Local Development

The following assumes the use of `node@>=18`. Contracts are compiled with the
[`@quantumcoin/solc`](https://www.npmjs.com/package/@quantumcoin/solc) npm package
(QuantumCoin's Solidity 0.7.6 with 32-byte address support).

## Install Dependencies

`npm install`

## Compile Contracts

`npm run compile`

Production artifacts are built with `node scripts/build-production.js`, which pins compiler settings
(optimizer runs 999999, no metadata hash), generates Go bindings via `abigen2`
(default `C:\build\abigen2.exe`, override with `ABIGEN_PATH`), and writes a SHA-256 manifest.

## Run Tests

`npm test`

Tests run against a local QuantumCoin devnet using the `quantumcoin` SDK. The devnet is
downloaded, installed, and started automatically by `scripts/devnet.js` (Windows, macOS, and
Ubuntu). Overrides: `QC_RPC_URL`, `QC_DEVNET_DIR`, `QC_KEYSTORE`, `QC_KEY_PASSWORD`.

`npm run test:integration` additionally deploys the production artifacts from
`quantumswap-deploy` to the devnet and exercises the full add-liquidity/swap flow.
