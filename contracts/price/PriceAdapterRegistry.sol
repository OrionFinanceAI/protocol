// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapterRegistry.sol";
import "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PriceAdapterRegistry
 * @notice A registry contract that manages price adapters for different assets in the Orion protocol.
 * @dev This contract allows the configuration of price adapters for various assets in the investment universe.
 */
contract PriceAdapterRegistry is IPriceAdapterRegistry, Ownable {
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

    constructor(address initialOwner_, address configAddress_) Ownable(initialOwner_) {
        if (initialOwner_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress_ == address(0)) revert ErrorsLib.ZeroAddress();

        configAddress = configAddress_;
        updateFromConfig();
    }

    /// @notice Updates the price adapter precision from the config contract
    /// @dev This function is called by the owner to update the price adapter precision
    ///      when the config contract is updated.
    function updateFromConfig() public onlyOwner {
        priceAdapterDecimals = IOrionConfig(configAddress).priceAdapterDecimals();
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

        (uint256 rawPrice, uint8 priceDecimals) = adapter.getPriceData(asset);

        return _normalizePrice(rawPrice, priceDecimals, priceAdapterDecimals);
    }

    /// @notice Normalizes a price from source decimals to target decimals
    /// @param price The raw price to normalize
    /// @param sourceDecimals The number of decimals in the source price
    /// @param targetDecimals The number of decimals to normalize to
    /// @return The normalized price
    function _normalizePrice(
        uint256 price,
        uint8 sourceDecimals,
        uint8 targetDecimals
    ) internal pure returns (uint256) {
        if (sourceDecimals == targetDecimals) {
            return price;
        } else if (sourceDecimals < targetDecimals) {
            return price * (10 ** (targetDecimals - sourceDecimals));
        } else {
            return price / (10 ** (sourceDecimals - targetDecimals));
        }
    }
    // TODO: same logic as _convertDecimals from InternalStatesOrchestrator.sol, avoid code duplication
    // for security and readability.
}
