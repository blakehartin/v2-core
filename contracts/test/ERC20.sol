pragma solidity =0.7.6;

import '../QuantumSwapV2ERC20.sol';

contract ERC20 is QuantumSwapV2ERC20 {
    constructor(uint _totalSupply) public {
        _mint(msg.sender, _totalSupply);
    }
}
