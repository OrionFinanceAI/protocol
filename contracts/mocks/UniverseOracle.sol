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
    /// @notice ERC‑20 / ERC‑721 / ERC‑1155 asset this oracle is bound to
    address public asset;

    /// @notice Last stored price
    uint256 private lastPrice;

    /// @param asset_       The asset this oracle serves
    /// @param initialPrice First price to store
    /// @param owner_       Initial owner (usually the deployer / dev ops EOA)
    function initialize(address asset_, uint256 initialPrice, address owner_) external initializer {
        if (asset_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (initialPrice == 0) revert ErrorsLib.ZeroPrice();

        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        asset = asset_;
        lastPrice = initialPrice;

        _transferOwnership(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @inheritdoc IAssetOracle
    function price() external view override returns (uint256) {
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
        emit EventsLib.PriceUpdated(asset, newPrice);
    }
}
