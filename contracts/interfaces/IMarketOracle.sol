// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

// TODO
interface IMarketOracle {
    function getPrices() external view returns (uint256 previousPrice, uint256 currentPrice);
}
