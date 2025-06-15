// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract MarketOracle is Ownable2Step {
    constructor() Ownable(msg.sender) {}

    struct Price {
        uint256 previous;
        uint256 current;
    }

    Price[] public prices;

    // TODO: to avoid returning asset address, make sure the components match the whitelisted universe.
    // Support the case in which the whitelist changed from the previous call.

    function getPrices() external view returns (Price[] memory) {
        // TODO: Implement this function

        Price[] memory prices = new Price[](2);
        prices[0] = Price({ previous: 1000000000000000000, current: 1000000000000000000 });
        prices[1] = Price({ previous: 1000000000000000000, current: 1000000000000000000 });

        return prices;
    }

    // TODO: two functions, one returning previous price
}
