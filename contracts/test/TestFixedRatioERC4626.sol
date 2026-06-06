// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice ERC-4626 vault with fixed totalAssets/totalSupply for ratio-based price adapter tests.
contract TestFixedRatioERC4626 is ERC4626 {
    using Math for uint256;
    uint8 private immutable _shareDecimals;
    uint256 private immutable _fixedTotalAssets;
    uint256 private immutable _fixedTotalSupply;

    constructor(
        ERC20 underlyingAsset_,
        string memory name_,
        string memory symbol_,
        uint8 shareDecimals_,
        uint256 fixedTotalAssets_,
        uint256 fixedTotalSupply_
    ) ERC20(name_, symbol_) ERC4626(underlyingAsset_) {
        _shareDecimals = shareDecimals_;
        _fixedTotalAssets = fixedTotalAssets_;
        _fixedTotalSupply = fixedTotalSupply_;
    }

    function decimals() public view override returns (uint8) {
        return _shareDecimals;
    }

    function totalAssets() public view override returns (uint256) {
        return _fixedTotalAssets;
    }

    function totalSupply() public view override(ERC20, IERC20) returns (uint256) {
        return _fixedTotalSupply;
    }

    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return shares.mulDiv(_fixedTotalAssets, _fixedTotalSupply);
    }
}
