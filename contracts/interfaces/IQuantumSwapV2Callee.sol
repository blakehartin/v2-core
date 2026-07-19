// This contract is part of QuantumSwap V2, a modified fork of Uniswap V2 (https://github.com/Uniswap/v2-core)
// adapted for the QuantumCoin blockchain. Modified from the original; see repository history for changes.
pragma solidity =0.7.6;

interface IQuantumSwapV2Callee {
    function quantumSwapV2Call(address sender, uint amount0, uint amount1, bytes calldata data) external;
}
