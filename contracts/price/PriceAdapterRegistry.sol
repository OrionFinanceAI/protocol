// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapterRegistry.sol";
import "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { UtilitiesLib } from "../libraries/UtilitiesLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title PriceAdapterRegistry
 * @notice A registry contract that manages price adapters for different assets in the Orion protocol.
 * @author Orion Finance
 * @dev This contract allows the configuration of price adapters for various assets in the investment universe.
 */
contract PriceAdapterRegistry is IPriceAdapterRegistry, Ownable2Step {
    /// @notice Orion Config contract address
    address public configAddress;

    /// @notice Price Adapter Precision
    uint8 public priceAdapterDecimals;

    /// @notice Mapping of asset addresses to their corresponding price adapters
    mapping(address => IPriceAdapter) public adapterOf;

    modifier onlyConfig() {
        if (msg.sender != configAddress) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor
    /// @param initialOwner_ The address of the initial owner
    /// @param configAddress_ The address of the OrionConfig contract
    constructor(address initialOwner_, address configAddress_) Ownable(initialOwner_) {
        if (initialOwner_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress_ == address(0)) revert ErrorsLib.ZeroAddress();

        configAddress = configAddress_;
        priceAdapterDecimals = IOrionConfig(configAddress).priceAdapterDecimals();
    }

    /// @inheritdoc IPriceAdapterRegistry
    function setPriceAdapter(address asset, IPriceAdapter adapter) external onlyConfig {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        adapter.validatePriceAdapter(asset);

        adapterOf[asset] = adapter;
        emit EventsLib.PriceAdapterSet(asset, address(adapter));
    }

    /// @inheritdoc IPriceAdapterRegistry
    function getPrice(address asset) external view returns (uint256) {
        IPriceAdapter adapter = adapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        (uint256 rawPrice, uint8 priceDecimals) = adapter.getPriceData(asset);

        return UtilitiesLib.convertDecimals(rawPrice, priceDecimals, priceAdapterDecimals);
    }
}
