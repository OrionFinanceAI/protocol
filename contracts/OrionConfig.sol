// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
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
contract OrionConfig is Ownable2Step, IOrionConfig {
    /// @notice Admin address (immutable, set at construction)
    address public immutable admin;

    /// @notice Guardian address for emergency pausing
    address public guardian;

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
    /// @notice Maximum risk-free rate (8% = 800)
    uint16 public constant MAX_RISK_FREE_RATE = 800;
    /// @notice Minimum deposit amount in underlying asset units
    uint256 public minDepositAmount;
    /// @notice Minimum redeem amount in share units
    uint256 public minRedeemAmount;
    /// @notice Fee change cooldown duration in seconds (7 days default)
    uint256 public feeChangeCooldownDuration;

    // Vault-specific configuration
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;
    EnumerableSet.AddressSet private whitelistedVaultOwners;
    EnumerableSet.AddressSet private whitelistedCurators;

    /// @notice Mapping of token address to its decimals
    mapping(address => uint8) public tokenDecimals;

    // Orion-specific configuration
    EnumerableSet.AddressSet private transparentVaults;
    EnumerableSet.AddressSet private encryptedVaults;
    EnumerableSet.AddressSet private decommissioningInProgressVaults;
    EnumerableSet.AddressSet private decommissionedVaults;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    modifier onlyFactories() {
        if (msg.sender != transparentVaultFactory) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != liquidityOrchestrator) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice The constructor sets the underlying asset for the protocol
    /// @param initialOwner The address that will own this contract
    /// @param admin_ The address that will have admin privileges
    /// @param underlyingAsset_ The address of the underlying asset contract
    /// @dev The underlying asset is automatically added to the investment universe whitelist because:
    /// @dev - Curators may decide to be underleveraged in their active positions;
    /// @dev - removeWhitelistedAsset could trigger forced liquidations.
    constructor(address initialOwner, address admin_, address underlyingAsset_) Ownable(initialOwner) {
        if (admin_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (underlyingAsset_ == address(0)) revert ErrorsLib.ZeroAddress();
        admin = admin_;
        underlyingAsset = IERC20(underlyingAsset_);

        curatorIntentDecimals = 9; // 9 for uint32
        priceAdapterDecimals = 14; // 14 for uint128
        feeChangeCooldownDuration = 7 days; // Default 7 day cooldown

        // Store underlying asset decimals
        tokenDecimals[underlyingAsset_] = IERC20Metadata(underlyingAsset_).decimals();

        // slither-disable-next-line unused-return
        whitelistedAssets.add(underlyingAsset_);

        // slither-disable-next-line unused-return
        whitelistedVaultOwners.add(initialOwner);
        // slither-disable-next-line unused-return
        whitelistedCurators.add(initialOwner);
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
        if (_riskFreeRate > MAX_RISK_FREE_RATE) revert ErrorsLib.InvalidArguments();

        riskFreeRate = _riskFreeRate;

        emit EventsLib.RiskFreeRateUpdated(riskFreeRate);
    }

    /// @inheritdoc IOrionConfig
    function setMinDepositAmount(uint256 amount) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (amount == 0) revert ErrorsLib.InvalidArguments();

        minDepositAmount = amount;

        emit EventsLib.MinDepositAmountUpdated(amount);
    }

    /// @inheritdoc IOrionConfig
    function setMinRedeemAmount(uint256 amount) external onlyOwner {
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

    // === Whitelist Functions ===

    /// @inheritdoc IOrionConfig
    function addWhitelistedAsset(address asset, address priceAdapter, address executionAdapter) external onlyOwner {
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Fail early to avoid owner overwriting adapters of existing asset with malicious ones
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
    function removeWhitelistedAsset(address asset) external onlyAdmin {
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
    function addWhitelistedVaultOwner(address vaultOwner) external onlyOwner {
        bool inserted = whitelistedVaultOwners.add(vaultOwner);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();
    }

    /// @inheritdoc IOrionConfig
    function removeWhitelistedVaultOwner(address vaultOwner) external onlyOwner {
        if (!this.isWhitelistedVaultOwner(vaultOwner)) revert ErrorsLib.InvalidAddress();
        if (!isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Decommission all vaults owned by this vault owner
        // Check transparent vaults
        address[] memory transparentVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaultsList.length; ++i) {
            address vault = transparentVaultsList[i];
            if (IOrionVault(vault).vaultOwner() == vaultOwner) {
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
            if (IOrionVault(vault).vaultOwner() == vaultOwner) {
                // Mark vault for decommissioning
                // slither-disable-next-line unused-return
                decommissioningInProgressVaults.add(vault);
                IOrionVault(vault).overrideIntentForDecommissioning();
            }
        }

        bool removed = whitelistedVaultOwners.remove(vaultOwner);
        if (!removed) revert ErrorsLib.InvalidAddress();

        emit EventsLib.VaultOwnerRemoved(vaultOwner);
    }

    /// @inheritdoc IOrionConfig
    function isWhitelistedVaultOwner(address vaultOwner) external view returns (bool) {
        return whitelistedVaultOwners.contains(vaultOwner);
    }

    /// @inheritdoc IOrionConfig
    function addWhitelistedCurator(address curator) external onlyOwner {
        bool inserted = whitelistedCurators.add(curator);
        if (!inserted) revert ErrorsLib.AlreadyRegistered();
    }

    /// @inheritdoc IOrionConfig
    function removeWhitelistedCurator(address curator) external onlyOwner {
        if (!this.isWhitelistedCurator(curator)) revert ErrorsLib.InvalidAddress();

        bool removed = whitelistedCurators.remove(curator);
        if (!removed) revert ErrorsLib.InvalidAddress();
    }

    /// @inheritdoc IOrionConfig
    function isWhitelistedCurator(address curator) external view returns (bool) {
        return whitelistedCurators.contains(curator);
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
    function removeOrionVault(address vault) external onlyAdmin {
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
        if (!decommissioningInProgressVaults.contains(vault)) revert ErrorsLib.InvalidAddress();

        // Remove from appropriate vault list - use remove() return value instead of contains() + remove()
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
            IInternalStateOrchestrator(internalStatesOrchestrator).currentPhase() ==
            IInternalStateOrchestrator.InternalUpkeepPhase.Idle;
    }

    /// @inheritdoc IOrionConfig
    function getTokenDecimals(address token) external view returns (uint8) {
        return tokenDecimals[token];
    }

    // === Emergency Pause Functions ===

    /// @notice Sets the guardian address for emergency pausing
    /// @param _guardian The new guardian address
    /// @dev Only admin can set the guardian
    function setGuardian(address _guardian) external onlyAdmin {
        guardian = _guardian;
        emit EventsLib.GuardianUpdated(_guardian);
    }

    /// @notice Pauses all protocol operations across orchestrators and vaults
    /// @dev Can only be called by guardian or admin
    ///      Pauses InternalStatesOrchestrator, LiquidityOrchestrator, and all vaults
    function pauseAll() external {
        if (msg.sender != guardian && msg.sender != admin) revert ErrorsLib.UnauthorizedAccess();

        // Pause orchestrators by calling their public pause() functions
        IInternalStateOrchestrator(internalStatesOrchestrator).pause();
        ILiquidityOrchestrator(liquidityOrchestrator).pause();

        // Pause all transparent vaults
        address[] memory transparentVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaultsList.length; ++i) {
            IOrionVault(transparentVaultsList[i]).pause();
        }

        // Pause all encrypted vaults
        address[] memory encryptedVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        for (uint256 i = 0; i < encryptedVaultsList.length; ++i) {
            IOrionVault(encryptedVaultsList[i]).pause();
        }

        emit EventsLib.ProtocolPaused(msg.sender);
    }

    /// @notice Unpauses all protocol operations across orchestrators and vaults
    /// @dev Can only be called by admin (not guardian - requires admin approval to resume)
    ///      Unpauses InternalStatesOrchestrator, LiquidityOrchestrator, and all vaults
    function unpauseAll() external onlyAdmin {
        // Unpause orchestrators
        IInternalStateOrchestrator(internalStatesOrchestrator).unpause();
        ILiquidityOrchestrator(liquidityOrchestrator).unpause();

        // Unpause all transparent vaults
        address[] memory transparentVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaultsList.length; ++i) {
            IOrionVault(transparentVaultsList[i]).unpause();
        }

        // Unpause all encrypted vaults
        address[] memory encryptedVaultsList = this.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        for (uint256 i = 0; i < encryptedVaultsList.length; ++i) {
            IOrionVault(encryptedVaultsList[i]).unpause();
        }

        emit EventsLib.ProtocolUnpaused(msg.sender);
    }
}
