// This contract is part of QuantumSwap V2, a modified fork of Uniswap V2 (https://github.com/Uniswap/v2-core)
// adapted for the QuantumCoin blockchain. Modified from the original; see repository history for changes.
pragma solidity >=0.5.0;

interface IQuantumSwapV2Factory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function INIT_CODE_HASH() external view returns (bytes32);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
}
