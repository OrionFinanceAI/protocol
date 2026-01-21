// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC4626Asset is ERC4626 {
    uint8 private immutable _decimals;

    constructor(
        ERC20 _underlyingAsset,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) ERC4626(_underlyingAsset) {
        _decimals = _underlyingAsset.decimals();
    }

    /// @notice Override to return underlying asset decimals instead of default 18
    function decimals() public view virtual override(ERC4626) returns (uint8) {
        return _decimals;
    }

    /// @notice Simulate gains by directly transferring underlying assets to the vault
    /// @dev This increases total assets without minting shares, effectively increasing share price
    /// @param amount The amount of underlying assets to transfer to the vault
    function simulateGains(uint256 amount) external {
        IERC20(asset()).transferFrom(msg.sender, address(this), amount);
    }

    /// @notice Simulate losses by directly transferring underlying assets out of the vault
    /// @dev This decreases total assets without burning shares, effectively decreasing share price
    /// @param amount The amount of underlying assets to transfer out of the vault
    /// @param to The address to send the underlying assets to
    function simulateLosses(uint256 amount, address to) external {
        IERC20(asset()).transfer(to, amount);
    }
}
