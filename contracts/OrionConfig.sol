// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
 * @notice Configuration contract for Orion protocol using UUPS upgradeable pattern
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract OrionConfig is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IOrionConfig {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Guardian address for emergency pausing
    address public guardian;

    /// @notice Underlying asset address
    IERC20 public underlyingAsset;
    /// @notice Address of the internal state orchestrator
    address public InternalStateOrchestrator;
    /// @notice Address of the liquidity orchestrator
    address public liquidityOrchestrator;
    /// @notice Address of the transparent vault factory
    address public transparentVaultFactory;
    /// @notice Address of the price adapter registry
    address public priceAdapterRegistry;

    /// @notice Decimals for strategist intent
    uint8 public constant strategistIntentDecimals = 9;
    /// @notice Decimals for price adapter
    uint8 public priceAdapterDecimals;
    /// @notice Risk-free rate in basis points. Same decimals as BASIS_POINTS_FACTOR
    uint16 public riskFreeRate;
    /// @notice Maximum risk-free rate (8% = 800)
    uint16 public constant MAX_RISK_FREE_RATE = 800;
    /// @notice Minimum deposit amount in underlying asset units
    uint256 public minDepositAmount;
    /// @notice Minimum redeem amount in share units
    uint256 public minRedeemAmount;
    /// @notice Fee change cooldown duration in seconds (7 days default)
    uint256 public feeChangeCooldownDuration;
    /// @notice Maximum number of requests to process per fulfill calls
    uint256 public maxFulfillBatchSize;

    // Vault-specific configuration
    EnumerableSet.AddressSet private whitelistedAssets;
    EnumerableSet.AddressSet private whitelistedManager;

    /// @notice Mapping of token address to its decimals
    mapping(address => uint8) public tokenDecimals;

    // Orion-specific configuration
    EnumerableSet.AddressSet private transparentVaults;
    EnumerableSet.AddressSet private encryptedVaults;
    EnumerableSet.AddressSet private decommissioningInProgressVaults;
    EnumerableSet.AddressSet private decommissionedVaults;

    modifier onlyFactories() {
        if (msg.sender != transparentVaultFactory) revert ErrorsLib.NotAuthorized();
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != liquidityOrchestrator) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializer function (replaces constructor)
    /// @param initialOwner The address that will own this contract
    /// @param underlyingAsset_ The address of the underlying asset contract
    /// @dev The underlying asset is automatically added to the investment universe whitelist because:
    /// @dev - Strategists may decide to be underleveraged in their active positions;
    /// @dev - removeWhitelistedAsset could trigger forced liquidations.
    function initialize(address initialOwner, address underlyingAsset_) public initializer {
        if (initialOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (underlyingAsset_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        underlyingAsset = IERC20(underlyingAsset_);

        priceAdapterDecimals = 14; // 14 for uint128
        feeChangeCooldownDuration = 7 days; // Default 7 day cooldown
        maxFulfillBatchSize = 150; // Default 150 requests per fulfill call

        // Store underlying asset decimals
        tokenDecimals[underlyingAsset_] = IERC20Metadata(underlyingAsset_).decimals();

        // slither-disable-next-line unused-return
        whitelistedAssets.add(underlyingAsset_);

        // slither-disable-next-line unused-return
        whitelistedManager.add(initialOwner);
    }

    // === Protocol Configuration ===

    /// @inheritdoc IOrionConfig
    function setInternalStateOrchestrator(address orchestrator) external onlyOwner {
        if (orchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        if (InternalStateOrchestrator != address(0)) revert ErrorsLib.AlreadyRegistered();
        InternalStateOrchestrator = orchestrator;
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
        if (_riskFreeRate > MAX_RISK_FREE_RATE) revert ErrorsLib.InvalidArguments();

        riskFreeRate = _riskFreeRate;

        emit EventsLib.RiskFreeRateUpdated(riskFreeRate);
    }

    /// @inheritdoc IOrionConfig
    function setMinDepositAmount(uint256 amount) external {
        if (msg.sender != guardian && msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (amount == 0) revert ErrorsLib.InvalidArguments();

        minDepositAmount = amount;

        emit EventsLib.MinDepositAmountUpdated(amount);
    }

    /// @inheritdoc IOrionConfig
    function setMinRedeemAmount(uint256 amount) external {
        if (msg.sender != guardian && msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (amount == 0) revert ErrorsLib.InvalidArguments();

        minRedeemAmount = amount;

        emit EventsLib.MinRedeemAmountUpdated(amount);
    }

    /// @inheritdoc IOrionConfig
    function setFeeChangeCooldownDuration(uint256 duration) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        feeChangeCooldownDuration = duration;

        emit EventsLib.FeeChangeCooldownDurationUpdated(duration);
    }

    /// @inheritdoc IOrionConfig
    function setMaxFulfillBatchSize(uint256 size) external {
        if (msg.sender != guardian && msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (size == 0) revert ErrorsLib.InvalidArguments();

        maxFulfillBatchSize = size;

        emit EventsLib.MaxFulfillBatchSizeUpdated(size);
    }

    /// @notice Sets the guardian address for emergency pausing
    /// @param _guardian The new guardian address
    /// @dev Only owner can set the guardian
    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ErrorsLib.ZeroAddress();

        guardian = _guardian;
        emit EventsLib.GuardianUpdated(_guardian);
    }

    /// @notice Pauses all protocol operations across orchestrators
    /// @dev Can only be called by guardian or owner
    ///      Pauses InternalStateOrchestrator and LiquidityOrchestrator
    function pauseAll() external {
        if (msg.sender != guardian && msg.sender != owner()) revert ErrorsLib.NotAuthorized();

        IInternalStateOrchestrator(InternalStateOrchestrator).pause();
        ILiquidityOrchestrator(liquidityOrchestrator).pause();

        emit EventsLib.ProtocolPaused(msg.sender);
    }

    /// @notice Unpauses all protocol operations across orchestrators
    /// @dev Can only be called by owner (not guardian: requires owner approval to resume)
    ///      Unpauses InternalStateOrchestrator and LiquidityOrchestrator
    function unpauseAll() external onlyOwner {
        IInternalStateOrchestrator(InternalStateOrchestrator).unpause();
        ILiquidityOrchestrator(liquidityOrchestrator).unpause();

        emit EventsLib.ProtocolUnpaused(msg.sender);
    }

    // === Whitelist Functions ===

    /// @inheritdoc IOrionConfig
    function addWhitelistedAsset(address asset, address priceAdapter, address executionAdapter) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        if (!this.isWhitelisted(asset)) {
            // slither-disable-next-line unused-return
            whitelistedAssets.add(asset);
        }

        // Store token decimals
        tokenDecimals[asset] = IERC20Metadata(asset).decimals();

        // Register the adapters
        IPriceAdapterRegistry(priceAdapterRegistry).setPriceAdapter(asset, IPriceAdapter(priceAdapter));
        ILiquidityOrchestrator(liquidityOrchestrator).setExecutionAdapter(asset, IExecutionAdapter(executionAdapter));

        emit EventsLib.WhitelistedAssetAdded(asset);
    }

    /// @inheritdoc IOrionConfig
    function removeWhitelistedAsset(address asset) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        if (asset == address(underlyingAsset)) revert ErrorsLib.InvalidArguments();

        bool removed = whitelistedAssets.remove(asset);
        if (!removed) revert ErrorsLib.TokenNotWhitelisted(asset);

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
    function addWhitelistedManager(address manager) external {
        if (msg.sender != guardian && msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        bool inserted = whitelistedManager.add(manager);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();
    }

    /// @inheritdoc IOrionConfig
    function removeWhitelistedManager(address manager) external onlyOwner {
        if (!this.isWhitelistedManager(manager)) revert ErrorsLib.InvalidAddress();
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Decommission all vaults associated with this manager
        // Check transparent vaults
        address[] memory transparentVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaultsList.length; ++i) {
            address vault = transparentVaultsList[i];
            if (IOrionVault(vault).manager() == manager) {
                // Mark vault for decommissioning
                // slither-disable-next-line unused-return
                decommissioningInProgressVaults.add(vault);
                IOrionVault(vault).overrideIntentForDecommissioning();
            }
        }

        // Check encrypted vaults
        address[] memory encryptedVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        for (uint256 i = 0; i < encryptedVaultsList.length; ++i) {
            address vault = encryptedVaultsList[i];
            if (IOrionVault(vault).manager() == manager) {
                // Mark vault for decommissioning
                // slither-disable-next-line unused-return
                decommissioningInProgressVaults.add(vault);
                IOrionVault(vault).overrideIntentForDecommissioning();
            }
        }

        bool removed = whitelistedManager.remove(manager);
        if (!removed) revert ErrorsLib.InvalidAddress();

        emit EventsLib.ManagerRemoved(manager);
    }

    /// @inheritdoc IOrionConfig
    function isWhitelistedManager(address manager) external view returns (bool) {
        return whitelistedManager.contains(manager);
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
    function removeOrionVault(address vault) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        if (!this.isOrionVault(vault)) {
            revert ErrorsLib.InvalidAddress();
        }
        // slither-disable-next-line unused-return
        decommissioningInProgressVaults.add(vault);
        IOrionVault(vault).overrideIntentForDecommissioning();
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
    function isDecommissioningVault(address vault) external view returns (bool) {
        return decommissioningInProgressVaults.contains(vault);
    }

    /// @inheritdoc IOrionConfig
    function isDecommissionedVault(address vault) external view returns (bool) {
        return decommissionedVaults.contains(vault);
    }

    /// @inheritdoc IOrionConfig
    function completeVaultDecommissioning(address vault) external onlyLiquidityOrchestrator {
        if (!this.isDecommissioningVault(vault)) revert ErrorsLib.InvalidAddress();

        bool removedFromEncrypted = encryptedVaults.remove(vault);
        if (!removedFromEncrypted) {
            bool removedFromTransparent = transparentVaults.remove(vault);
            if (!removedFromTransparent) {
                revert ErrorsLib.InvalidAddress();
            }
        }

        // Remove from decommissioning in progress list
        // slither-disable-next-line unused-return
        decommissioningInProgressVaults.remove(vault);

        // Add to decommissioned vaults list
        // slither-disable-next-line unused-return
        decommissionedVaults.add(vault);
    }

    /// @inheritdoc IOrionConfig
    function isSystemIdle() public view returns (bool) {
        return
            ILiquidityOrchestrator(liquidityOrchestrator).currentPhase() ==
            ILiquidityOrchestrator.LiquidityUpkeepPhase.Idle &&
            IInternalStateOrchestrator(InternalStateOrchestrator).currentPhase() ==
            IInternalStateOrchestrator.InternalUpkeepPhase.Idle;
    }

    /// @inheritdoc IOrionConfig
    function getTokenDecimals(address token) external view returns (uint8) {
        return tokenDecimals[token];
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
