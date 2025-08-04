// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { EventsLib } from "./libraries/EventsLib.sol";
import "./interfaces/IPriceAdapterRegistry.sol";
import "./interfaces/ILiquidityOrchestrator.sol";
import "./interfaces/IPriceAdapter.sol";
import "./interfaces/IExecutionAdapter.sol";
import "./interfaces/IInternalStateOrchestrator.sol";

/**
 *     ██████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗    ███████╗██╗███╗   ██╗ █████╗ ███╗   ██╗ ██████╗███████╗
 *    ██╔═══██╗██╔══██╗██║██╔═══██╗████╗  ██║    ██╔════╝██║████╗  ██║██╔══██╗████╗  ██║██╔════╝██╔════╝
 *    ██║   ██║██████╔╝██║██║   ██║██╔██╗ ██║    █████╗  ██║██╔██╗ ██║███████║██╔██╗ ██║██║     █████╗
 *    ██║   ██║██╔══██╗██║██║   ██║██║╚██╗██║    ██╔══╝  ██║██║╚██╗██║██╔══██║██║╚██╗██║██║     ██╔══╝
 *    ╚██████╔╝██║  ██║██║╚██████╔╝██║ ╚████║    ██║     ██║██║ ╚████║██║  ██║██║ ╚████║╚██████╗███████╗
 *     ╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝╚══════╝
 *
 * @title OrionConfig
 * @notice This contract is responsible for configuring the Orion protocol.
 */
contract OrionConfig is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IOrionConfig {
    // Protocol-wide configuration
    IERC20 public underlyingAsset;
    address public internalStatesOrchestrator;
    address public liquidityOrchestrator;
    address public vaultFactory;
    address public priceAdapterRegistry;

    // Curator-specific configuration
    uint8 public curatorIntentDecimals;

    // Vault-specific configuration
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;

    // Orion-specific configuration
    EnumerableSet.AddressSet private transparentVaults;
    EnumerableSet.AddressSet private encryptedVaults;

    modifier onlyFactory() {
        if (msg.sender != vaultFactory) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    // === Protocol Configuration ===

    /// @inheritdoc IOrionConfig
    function setUnderlyingAsset(address asset) external onlyOwner {
        if (asset == address(0)) revert ErrorsLib.ZeroAddress();
        underlyingAsset = IERC20(asset);
    }

    /// @inheritdoc IOrionConfig
    function setInternalStatesOrchestrator(address orchestrator) external onlyOwner {
        if (orchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        internalStatesOrchestrator = orchestrator;
    }

    /// @inheritdoc IOrionConfig
    function setProtocolParams(
        address liquidityOrchestrator_,
        uint8 curatorIntentDecimals_,
        address factory_,
        address priceAdapterRegistry_
    ) external onlyOwner {
        if (liquidityOrchestrator_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (factory_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (priceAdapterRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();

        liquidityOrchestrator = liquidityOrchestrator_;

        curatorIntentDecimals = curatorIntentDecimals_;
        vaultFactory = factory_;
        priceAdapterRegistry = priceAdapterRegistry_;

        emit EventsLib.ProtocolParamsUpdated();
    }

    // === Whitelist Functions ===

    /// @inheritdoc IOrionConfig
    function addWhitelistedAsset(address asset, address priceAdapter, address executionAdapter) external onlyOwner {
        bool inserted = whitelistedAssets.add(asset);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();

        // Register the adapters
        IPriceAdapterRegistry(priceAdapterRegistry).setPriceAdapter(asset, IPriceAdapter(priceAdapter));
        ILiquidityOrchestrator(liquidityOrchestrator).setExecutionAdapter(asset, IExecutionAdapter(executionAdapter));

        emit EventsLib.WhitelistedAssetAdded(asset);
    }

    /// @inheritdoc IOrionConfig
    function removeWhitelistedAsset(address asset) external onlyOwner {
        bool removed = whitelistedAssets.remove(asset);
        if (!removed) revert ErrorsLib.TokenNotWhitelisted(asset);

        IPriceAdapterRegistry(priceAdapterRegistry).unsetPriceAdapter(asset);
        ILiquidityOrchestrator(liquidityOrchestrator).unsetExecutionAdapter(asset);

        emit EventsLib.WhitelistedAssetRemoved(asset);
    }

    /// @inheritdoc IOrionConfig
    function whitelistedAssetsLength() external view returns (uint256) {
        return whitelistedAssets.length();
    }

    /// @inheritdoc IOrionConfig
    function getWhitelistedAssetAt(uint256 index) external view returns (address) {
        return whitelistedAssets.at(index);
    }

    /// @inheritdoc IOrionConfig
    function getAllWhitelistedAssets() external view returns (address[] memory assets) {
        uint256 length = whitelistedAssets.length();
        assets = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            assets[i] = whitelistedAssets.at(i);
        }
        return assets;
    }

    /// @inheritdoc IOrionConfig
    function isWhitelisted(address asset) external view returns (bool) {
        return whitelistedAssets.contains(asset);
    }

    // === Orion Vaults ===

    /// @inheritdoc IOrionConfig
    function addOrionVault(address vault, EventsLib.VaultType vaultType) external onlyFactory {
        if (vault == address(0)) revert ErrorsLib.ZeroAddress();

        bool inserted;
        if (vaultType == EventsLib.VaultType.Encrypted) {
            inserted = encryptedVaults.add(vault);
        } else {
            inserted = transparentVaults.add(vault);
        }

        if (!inserted) revert ErrorsLib.AlreadyRegistered();
        emit EventsLib.OrionVaultAdded(vault);
    }

    /// @inheritdoc IOrionConfig
    function removeOrionVault(address vault, EventsLib.VaultType vaultType) external onlyFactory {
        bool removed;
        if (vaultType == EventsLib.VaultType.Encrypted) {
            removed = encryptedVaults.remove(vault);
        } else {
            removed = transparentVaults.remove(vault);
        }

        if (!removed) revert ErrorsLib.UnauthorizedAccess();
        emit EventsLib.OrionVaultRemoved(vault);
    }

    /// @inheritdoc IOrionConfig
    function getAllOrionVaults(EventsLib.VaultType vaultType) external view returns (address[] memory) {
        EnumerableSet.AddressSet storage vaults = vaultType == EventsLib.VaultType.Encrypted
            ? encryptedVaults
            : transparentVaults;
        uint256 length = vaults.length();
        address[] memory vaultArray = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            vaultArray[i] = vaults.at(i);
        }
        return vaultArray;
    }

    /// @inheritdoc IOrionConfig
    function isOrionVault(address vault) external view returns (bool) {
        return encryptedVaults.contains(vault) || transparentVaults.contains(vault);
    }

    /// @inheritdoc IOrionConfig
    function isSystemIdle() external view returns (bool) {
        return
            ILiquidityOrchestrator(liquidityOrchestrator).currentPhase() ==
            ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle &&
            IInternalStateOrchestrator(internalStatesOrchestrator).currentPhase() ==
            IInternalStateOrchestrator.InternalUpkeepPhase.Idle;
    }
}
