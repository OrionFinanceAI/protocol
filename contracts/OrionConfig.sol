// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IOrionTransparentVault.sol";
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
 * @author Orion Finance
 */
contract OrionConfig is Ownable, IOrionConfig {
    /// @notice Underlying asset address
    IERC20 public underlyingAsset;
    /// @notice Address of the internal states orchestrator
    address public internalStatesOrchestrator;
    /// @notice Address of the liquidity orchestrator
    address public liquidityOrchestrator;
    /// @notice Address of the transparent vault factory
    address public transparentVaultFactory;
    /// @notice Address of the price adapter registry
    address public priceAdapterRegistry;

    /// @notice Decimals for curator intent
    uint8 public curatorIntentDecimals;
    /// @notice Decimals for price adapter
    uint8 public priceAdapterDecimals;
    /// @notice Risk-free rate in basis points. Same decimals as BASIS_POINTS_FACTOR
    uint16 public riskFreeRate;

    // Vault-specific configuration
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;
    EnumerableSet.AddressSet private whitelistedVaultOwners;

    /// @notice Mapping of token address to its decimals
    mapping(address => uint8) public tokenDecimals;

    // Orion-specific configuration
    EnumerableSet.AddressSet private transparentVaults;
    EnumerableSet.AddressSet private encryptedVaults;

    modifier onlyFactories() {
        if (msg.sender != transparentVaultFactory) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    /// @notice The constructor sets the underlying asset for the protocol
    /// @param initialOwner The address that will own this contract
    /// @param underlyingAsset_ The address of the underlying asset contract
    /// @dev The underlying asset is automatically added to the investment universe whitelist because:
    /// @dev - Curators may decide to be underleveraged in their active positions;
    /// @dev - removeWhitelistedAsset could trigger forced liquidations.
    constructor(address initialOwner, address underlyingAsset_) Ownable(initialOwner) {
        if (underlyingAsset_ == address(0)) revert ErrorsLib.ZeroAddress();
        underlyingAsset = IERC20(underlyingAsset_);

        curatorIntentDecimals = 9; // 9 for uint32
        priceAdapterDecimals = 14; // 14 for uint128

        // Store underlying asset decimals
        tokenDecimals[underlyingAsset_] = IERC20Metadata(underlyingAsset_).decimals();

        // slither-disable-next-line unused-return
        whitelistedAssets.add(underlyingAsset_);

        // slither-disable-next-line unused-return
        whitelistedVaultOwners.add(initialOwner);
    }

    // === Protocol Configuration ===

    /// @inheritdoc IOrionConfig
    function setInternalStatesOrchestrator(address orchestrator) external onlyOwner {
        if (orchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        if (internalStatesOrchestrator != address(0)) revert ErrorsLib.AlreadyRegistered();
        internalStatesOrchestrator = orchestrator;
    }

    /// @inheritdoc IOrionConfig
    function setLiquidityOrchestrator(address orchestrator) external onlyOwner {
        if (orchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        if (liquidityOrchestrator != address(0)) revert ErrorsLib.AlreadyRegistered();
        liquidityOrchestrator = orchestrator;
    }

    /// @inheritdoc IOrionConfig
    function setVaultFactory(address transparentFactory) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (transparentFactory == address(0)) revert ErrorsLib.ZeroAddress();
        if (transparentVaultFactory != address(0)) revert ErrorsLib.AlreadyRegistered();
        transparentVaultFactory = transparentFactory;
    }

    /// @inheritdoc IOrionConfig
    function setPriceAdapterRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert ErrorsLib.ZeroAddress();
        if (priceAdapterRegistry != address(0)) revert ErrorsLib.AlreadyRegistered();
        priceAdapterRegistry = registry;
    }

    /// @inheritdoc IOrionConfig
    function setProtocolRiskFreeRate(uint16 _riskFreeRate) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        riskFreeRate = _riskFreeRate;

        emit EventsLib.RiskFreeRateUpdated(riskFreeRate);
    }

    // === Whitelist Functions ===

    /// @inheritdoc IOrionConfig
    function addWhitelistedAsset(address asset, address priceAdapter, address executionAdapter) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        bool inserted = whitelistedAssets.add(asset);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();

        // Store token decimals
        // Note: Assumes ERC20 decimals are immutable (standard-compliant).
        // Non-standard tokens that allow decimals to change at runtime MUST NOT be whitelisted.
        tokenDecimals[asset] = IERC20Metadata(asset).decimals();

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

        delete tokenDecimals[asset];

        // Loop over all transparent vaults to update their whitelists and intents
        address[] memory transparentVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaultsList.length; ++i) {
            address vault = transparentVaultsList[i];

            IOrionTransparentVault(vault).removeFromVaultWhitelist(asset);
        }
        emit EventsLib.WhitelistedAssetRemoved(asset);
    }

    /// @inheritdoc IOrionConfig
    function whitelistedAssetsLength() external view returns (uint16) {
        return uint16(whitelistedAssets.length());
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

    /// @inheritdoc IOrionConfig
    function addWhitelistedVaultOwner(address vaultOwner) external onlyOwner {
        bool inserted = whitelistedVaultOwners.add(vaultOwner);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();
    }

    /// @inheritdoc IOrionConfig
    function isWhitelistedVaultOwner(address vaultOwner) external view returns (bool) {
        return whitelistedVaultOwners.contains(vaultOwner);
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

    /// @inheritdoc IOrionConfig
    function getTokenDecimals(address token) external view returns (uint8) {
        return tokenDecimals[token];
    }
}
