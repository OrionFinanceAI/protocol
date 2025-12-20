// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IPriceAdapterRegistry.sol";
import "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { UtilitiesLib } from "../libraries/UtilitiesLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";

/**
 * @title PriceAdapterRegistry
 * @notice Price Adapter Registry using UUPS upgradeable pattern
 * @author Orion Finance
 * @dev This contract allows the configuration of price adapters for various assets in the investment universe.
 * @custom:security-contact security@orionfinance.ai
 */
contract PriceAdapterRegistry is Initializable, IPriceAdapterRegistry, Ownable2StepUpgradeable, UUPSUpgradeable {
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

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer function (replaces constructor)
    /// @param initialOwner_ The address of the initial owner
    /// @param configAddress_ The address of the OrionConfig contract
    function initialize(address initialOwner_, address configAddress_) public initializer {
        if (initialOwner_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner_);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

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

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
