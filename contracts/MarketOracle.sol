// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract MarketOracle is Ownable2Step {
    constructor() Ownable(msg.sender) {}

    function getPrices()
        external
        view
        returns (uint256[] memory previousPriceArray, uint256[] memory currentPriceArray)
    {
        // TODO: Implement this function
        previousPriceArray = new uint256[](1);
        currentPriceArray = new uint256[](1);
        previousPriceArray[0] = 1000000000000000000;
        currentPriceArray[0] = 1000000000000000000;
        return (previousPriceArray, currentPriceArray);
    }
}
