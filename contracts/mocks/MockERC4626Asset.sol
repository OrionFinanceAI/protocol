// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC4626Asset is ERC4626 {
    uint8 private _decimals;

    constructor(
        ERC20 _underlyingAsset,
        string memory _name,
        string memory _symbol,
        uint8 _shareDecimals
    ) ERC20(_name, _symbol) ERC4626(_underlyingAsset) {
        _decimals = _shareDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
