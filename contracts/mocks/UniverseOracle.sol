// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAssetOracle } from "../interfaces/IAssetOracle.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/// @title UniverseOracle (mock)
/// @notice One instance per asset. Produces pseudo‑random prices for testing.
contract UniverseOracle is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IAssetOracle {
    /// @notice Asset this oracle is bound to.
    address public asset;

    /// @notice Last stored price
    uint256 private lastPrice;

    /// @notice Flag to track if the oracle has been initialized with a price
    bool private isInitialized;

    function initialize(address asset_, address initialOwner) external initializer {
        if (asset_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        asset = asset_;
        isInitialized = false;

        _transferOwnership(initialOwner);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @inheritdoc IAssetOracle
    function price() external view override returns (uint256) {
        if (!isInitialized) revert ErrorsLib.OracleNotInitialized();
        return lastPrice;
    }

    /// @inheritdoc IAssetOracle
    function update() external override returns (uint256 newPrice) {
        // *** Mock randomness *** — DO NOT use in production, returning values between 1 and 100
        newPrice =
            (uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, asset, lastPrice))) %
                100) +
            1;

        lastPrice = newPrice;
        isInitialized = true;
        emit EventsLib.PriceUpdated(asset, newPrice);
    }
}
