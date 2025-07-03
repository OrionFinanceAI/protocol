// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IOracleRegistry.sol";
import "./interfaces/IAssetOracle.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

contract OracleRegistry is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IOracleRegistry {
    mapping(address => address) public oracleOf;

    function initialize(address initialOwner) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(initialOwner);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Owner registers or replaces the oracle for an asset
    function setOracle(address asset, address oracle) external onlyOwner {
        if (asset == address(0) || address(oracle) == address(0)) revert ErrorsLib.ZeroAddress();
        oracleOf[asset] = oracle;
        emit EventsLib.OracleRegistered(asset, address(oracle));
    }

    /// Pass through functions to the oracle
    function price(address asset) external view returns (uint256) {
        address assetOracle = oracleOf[asset];
        if (assetOracle == address(0)) revert ErrorsLib.OracleNotSet();
        return IAssetOracle(assetOracle).price();
    }

    function update(address asset) external returns (uint256 newPrice) {
        address assetOracle = oracleOf[asset];
        if (assetOracle == address(0)) revert ErrorsLib.OracleNotSet();
        return IAssetOracle(assetOracle).update();
    }
}
