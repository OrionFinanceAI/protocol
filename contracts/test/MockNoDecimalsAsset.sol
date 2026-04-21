// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Simulates a token that reverts on decimals(), covering the catch branch
///      in ApyStrategistBase._getSharePrice.
contract MockNoDecimalsAsset {
    function decimals() external pure returns (uint8) {
        revert("no decimals");
    }
}
