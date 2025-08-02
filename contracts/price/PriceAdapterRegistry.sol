// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IPriceAdapterRegistry.sol";
import "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title PriceAdapterRegistry
 * @notice A registry contract that manages price adapters for different assets in the Orion protocol.
 * @dev This contract allows the configuration of price adapters for various assets in the investment universe.
 */
contract PriceAdapterRegistry is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IPriceAdapterRegistry {
    mapping(address => IPriceAdapter) public adapterOf;
    address public configAddress;

    modifier onlyConfig() {
        if (msg.sender != configAddress) revert ErrorsLib.NotAuthorized();
        _;
    }

    function initialize(address initialOwner, address _configAddress) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        configAddress = _configAddress;
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @inheritdoc IPriceAdapterRegistry
    function setPriceAdapter(address asset, IPriceAdapter adapter) external onlyConfig {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        adapterOf[asset] = adapter;
        emit EventsLib.PriceAdapterSet(asset, address(adapter));
    }

    /// @inheritdoc IPriceAdapterRegistry
    function unsetPriceAdapter(address asset) external onlyConfig {
        if (asset == address(0)) revert ErrorsLib.ZeroAddress();
        delete adapterOf[asset];
        emit EventsLib.PriceAdapterSet(asset, address(0));
    }

    /// @inheritdoc IPriceAdapterRegistry
    function getPrice(address asset) external view returns (uint256) {
        IPriceAdapter adapter = adapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();
        return adapter.price(asset);
    }
}
