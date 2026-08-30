// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev USDC-like token that reverts on transfers to denylisted recipients.
contract MockBlacklistUnderlying is ERC20 {
    uint8 private immutable _decimals;

    mapping(address => bool) public isBlacklisted;

    error RecipientBlacklisted(address recipient);

    constructor(uint8 decimals_) ERC20("Mock Denylist USDC", "mUSDC") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool value) external {
        isBlacklisted[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && isBlacklisted[to]) {
            revert RecipientBlacklisted(to);
        }
        super._update(from, to, value);
    }
}
