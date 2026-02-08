// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../libraries/UtilitiesLib.sol";

contract UtilitiesLibTest {
    function convertDecimals(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) external pure returns (uint256 result) {
        return UtilitiesLib.convertDecimals(value, fromDecimals, toDecimals);
    }
}
