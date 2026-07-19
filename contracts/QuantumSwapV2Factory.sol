// This contract is part of QuantumSwap V2, a modified fork of Uniswap V2 (https://github.com/Uniswap/v2-core)
// adapted for the QuantumCoin blockchain. Modified from the original; see repository history for changes.
pragma solidity =0.7.6;

import './interfaces/IQuantumSwapV2Factory.sol';
import './QuantumSwapV2Pair.sol';

contract QuantumSwapV2Factory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    bytes32 public constant INIT_CODE_HASH = keccak256(abi.encodePacked(type(QuantumSwapV2Pair).creationCode));


    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    constructor(address _feeToSetter) public {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'QuantumSwapV2: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'QuantumSwapV2: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'QuantumSwapV2: PAIR_EXISTS'); // single check is sufficient
        bytes memory bytecode = type(QuantumSwapV2Pair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        IQuantumSwapV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, 'QuantumSwapV2: FORBIDDEN');
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, 'QuantumSwapV2: FORBIDDEN');
        feeToSetter = _feeToSetter;
    }
}
