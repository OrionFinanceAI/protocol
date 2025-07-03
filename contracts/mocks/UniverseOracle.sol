// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAssetOracle } from "../interfaces/IAssetOracle.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

/// @title UniverseOracle (mock)
/// @notice One instance per asset. Produces pseudo‑random prices for testing.
contract UniverseOracle is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IAssetOracle {
    /// @notice Asset this oracle is bound to.
    address public asset;

    function initialize(address asset_, address initialOwner) external initializer {
        if (asset_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        asset = asset_;

        _transferOwnership(initialOwner);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @inheritdoc IAssetOracle
    function price() external view returns (uint256) {
        // *** Mock randomness *** — DO NOT use in production, returning values between 1 and 100
        return (uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, asset))) % 100) + 1;
    }
}
