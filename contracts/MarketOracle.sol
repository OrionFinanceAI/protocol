// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract MarketOracle is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    struct Price {
        uint256 previous;
        uint256 current;
    }

    Price[] public prices;

    function initialize(address initialOwner) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(initialOwner);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // TODO: to avoid returning asset address, make sure the components match the whitelisted universe.
    // Support the case in which the whitelist changed from the previous call.

    function getPrices()
        external
        view
        returns (uint256[] memory previousPriceArray, uint256[] memory currentPriceArray)
    {
        // TODO: Implement this function

        // For now, return mock data with correct format
        previousPriceArray = new uint256[](2);
        currentPriceArray = new uint256[](2);

        previousPriceArray[0] = 1000000000000000000; // 1 ETH
        previousPriceArray[1] = 1000000000000000000; // 1 ETH

        currentPriceArray[0] = 1000000000000000000; // 1 ETH
        currentPriceArray[1] = 1000000000000000000; // 1 ETH

        return (previousPriceArray, currentPriceArray);
    }

    // TODO: two functions, one returning previous price
}
