// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev ERC4626-like vault whose `decimals()` reverts (metadata catch paths).
contract MockERC4626NoDecimals {
    address private immutable _asset;
    bool private _assetDecimalsReverts;

    constructor(address asset_, bool assetDecimalsReverts_) {
        _asset = asset_;
        _assetDecimalsReverts = assetDecimalsReverts_;
    }

    function asset() external view returns (address) {
        return _asset;
    }

    function decimals() external pure returns (uint8) {
        revert("no vault decimals");
    }
}

/// @dev Token with no ERC20 metadata (decimals reverts) used as a vault underlying.
contract MockTokenNoDecimals {
    function decimals() external pure returns (uint8) {
        revert("no token decimals");
    }
}

/// @dev ERC4626-like vault with working vault decimals but underlying that reverts on decimals().
contract MockERC4626BrokenUnderlyingDecimals {
    address private immutable _asset;
    uint8 private immutable _decimals;

    constructor(address asset_, uint8 decimals_) {
        _asset = asset_;
        _decimals = decimals_;
    }

    function asset() external view returns (address) {
        return _asset;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
