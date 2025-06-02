// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract UniverseERC4626Vault is ERC4626 {
    constructor(
        ERC20 _underlyingAsset,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) ERC4626(_underlyingAsset) {}
}
