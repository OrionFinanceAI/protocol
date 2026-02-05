// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../mocks/MockERC4626Asset.sol";

/**
 * @title MockERC4626WithSettableDecimals
 * @notice Test-only ERC4626 vault that allows changing reported decimals after deployment.
 *        Used to test adapter validation when asset decimals no longer match config.
 */
contract MockERC4626WithSettableDecimals is MockERC4626Asset {
    uint8 private _overrideDecimals;

    constructor(
        ERC20 _underlyingAsset,
        string memory _name,
        string memory _symbol
    ) MockERC4626Asset(_underlyingAsset, _name, _symbol) {
        _overrideDecimals = super.decimals();
    }

    function decimals() public view override returns (uint8) {
        return _overrideDecimals;
    }

    function setDecimals(uint8 d) external {
        _overrideDecimals = d;
    }
}
