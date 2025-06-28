// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

contract UnderlyingAsset is ERC20 {
    address public minter;

    constructor() ERC20("USD Coin", "USDC") {
        minter = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert ErrorsLib.NotAuthorized();
        _mint(to, amount);
    }
}
