const path = require("node:path");
const qcSolc = require("./qc-solc");

const root = path.resolve(__dirname, "..");

const output = qcSolc.compile([
  path.join(root, "contracts", "QuantumSwapV2Factory.sol"),
  path.join(root, "contracts", "test", "ERC20.sol"),
]);
qcSolc.writeArtifacts(output, path.join(root, "build"));
console.log(`v2-core contracts compiled OK (${qcSolc.compilerVersion()})`);
