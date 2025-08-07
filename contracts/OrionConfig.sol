// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
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
contract OrionConfig is Ownable, IOrionConfig {
    // Protocol-wide configuration
    IERC20 public underlyingAsset;

    address public internalStatesOrchestrator;
    address public liquidityOrchestrator;
    address public transparentVaultFactory;
    address public encryptedVaultFactory;
    address public priceAdapterRegistry;

    // Protocol parameters
    uint8 public priceAdapterDecimals;
    uint8 public curatorIntentDecimals;

    // Vault-specific configuration
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;

    // Orion-specific configuration
    EnumerableSet.AddressSet private transparentVaults;
    EnumerableSet.AddressSet private encryptedVaults;

    modifier onlyFactories() {
        if (msg.sender != transparentVaultFactory && msg.sender != encryptedVaultFactory)
            revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    // === Protocol Configuration ===

    /// @inheritdoc IOrionConfig
    function setUnderlyingAsset(address asset) external onlyOwner {
        if (asset == address(0)) revert ErrorsLib.ZeroAddress();
        underlyingAsset = IERC20(asset);

        bool inserted = whitelistedAssets.add(asset);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();

        emit EventsLib.WhitelistedAssetAdded(asset);
    }

    /// @inheritdoc IOrionConfig
    function setInternalStatesOrchestrator(address orchestrator) external onlyOwner {
        if (orchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        internalStatesOrchestrator = orchestrator;
    }

    /// @inheritdoc IOrionConfig
    function setLiquidityOrchestrator(address orchestrator) external onlyOwner {
        if (orchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        liquidityOrchestrator = orchestrator;
    }

    /// @inheritdoc IOrionConfig
    function setVaultFactories(address transparentFactory, address encryptedFactory) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (transparentFactory == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedFactory == address(0)) revert ErrorsLib.ZeroAddress();
        transparentVaultFactory = transparentFactory;
        encryptedVaultFactory = encryptedFactory;
    }

    /// @inheritdoc IOrionConfig
    function setPriceAdapterRegistry(address registry) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (registry == address(0)) revert ErrorsLib.ZeroAddress();
        priceAdapterRegistry = registry;
    }

    /// @inheritdoc IOrionConfig
    function setProtocolParams(uint8 _curatorIntentDecimals, uint8 _priceAdapterDecimals) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        curatorIntentDecimals = _curatorIntentDecimals;
        priceAdapterDecimals = _priceAdapterDecimals;

        emit EventsLib.ProtocolParamsUpdated();
    }

    // === Whitelist Functions ===

    /// @inheritdoc IOrionConfig
    function addWhitelistedAsset(address asset, address priceAdapter, address executionAdapter) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        bool inserted = whitelistedAssets.add(asset);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();

        // Register the adapters
        IPriceAdapterRegistry(priceAdapterRegistry).setPriceAdapter(asset, IPriceAdapter(priceAdapter));
        ILiquidityOrchestrator(liquidityOrchestrator).setExecutionAdapter(asset, IExecutionAdapter(executionAdapter));

        emit EventsLib.WhitelistedAssetAdded(asset);
    }

    /// @inheritdoc IOrionConfig
    function removeWhitelistedAsset(address asset) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        bool removed = whitelistedAssets.remove(asset);
        if (!removed) revert ErrorsLib.TokenNotWhitelisted(asset);

        IPriceAdapterRegistry(priceAdapterRegistry).unsetPriceAdapter(asset);
        ILiquidityOrchestrator(liquidityOrchestrator).unsetExecutionAdapter(asset);

        emit EventsLib.WhitelistedAssetRemoved(asset);
    }

    /// @inheritdoc IOrionConfig
    function whitelistedAssetsLength() external view returns (uint16) {
        return uint16(whitelistedAssets.length());
    }

    /// @inheritdoc IOrionConfig
    function getWhitelistedAssetAt(uint16 index) external view returns (address) {
        return whitelistedAssets.at(index);
    }

    /// @inheritdoc IOrionConfig
    function getAllWhitelistedAssets() external view returns (address[] memory assets) {
        uint16 length = uint16(whitelistedAssets.length());
        assets = new address[](length);
        for (uint16 i = 0; i < length; ++i) {
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
    function addOrionVault(address vault, EventsLib.VaultType vaultType) external onlyFactories {
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
    function removeOrionVault(address vault, EventsLib.VaultType vaultType) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

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
        uint16 length = uint16(vaults.length());
        address[] memory vaultArray = new address[](length);
        for (uint16 i = 0; i < length; ++i) {
            vaultArray[i] = vaults.at(i);
        }
        return vaultArray;
    }

    /// @inheritdoc IOrionConfig
    function isOrionVault(address vault) external view returns (bool) {
        return encryptedVaults.contains(vault) || transparentVaults.contains(vault);
    }

    /// @inheritdoc IOrionConfig
    function isSystemIdle() public view returns (bool) {
        return
            ILiquidityOrchestrator(liquidityOrchestrator).currentPhase() ==
            ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle &&
            IInternalStateOrchestrator(internalStatesOrchestrator).currentPhase() ==
            IInternalStateOrchestrator.InternalUpkeepPhase.Idle;
    }
}
