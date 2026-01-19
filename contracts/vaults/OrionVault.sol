// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import "@openzeppelin/contracts/utils/StorageSlot.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/ILiquidityOrchestrator.sol";
import "../interfaces/IOrionAccessControl.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title OrionVault
 * @notice Modular asset management vault with asynchronous deposits and redemptions
 * @author Orion Finance
 * @dev
 * Abstract base contract providing common functionality for transparent and encrypted vaults.
 * Implements an asynchronous deposit and redemption pattern inspired by ERC-7540 with custom enhancements:
 * - https://eips.ethereum.org/EIPS/eip-4626
 * - https://eips.ethereum.org/EIPS/eip-7540
 * - https://eips.ethereum.org/EIPS/eip-7887
 *
 * Strategist-submitted intents define portfolio allocation targets as percentages of total assets.
 * Derived contracts handle intent submission and interpretation:
 * - OrionTransparentVault: plaintext intents
 * - OrionEncryptedVault: encrypted, privacy-preserving intents
 *
 * Key vault states:
 * 1. Total Assets (_totalAssets) [assets] – total assets under management
 * 2. Deposit Requests (_depositRequests) [assets] – pending deposits, denominated in underlying tokens
 * 3. Redemption Requests (_redeemRequests) [shares] – pending redemptions, denominated in vault shares
 * 4. Portfolio Weights (w_0) [shares] – current allocation in share units for stateless TVL estimation
 * 5. Strategist Intent (w_1) [%] – target allocation in percentage of total supply
 */
abstract contract OrionVault is Initializable, ERC4626Upgradeable, ReentrancyGuardUpgradeable, IOrionVault {
    using Math for uint256;
    using SafeERC20 for IERC20;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Vault manager
    address public manager;
    /// @notice Vault strategist
    address public strategist;
    /// @notice OrionConfig contract
    IOrionConfig public config;
    /// @notice Liquidity orchestrator
    ILiquidityOrchestrator public liquidityOrchestrator;
    /// @notice Deposit access control contract (address(0) = permissionless)
    address public depositAccessControl;

    /// @notice Vault-specific whitelist of assets for intent validation
    /// @dev This is a subset of the protocol whitelist for higher auditability
    EnumerableSet.AddressSet internal _vaultWhitelistedAssets;

    /// @notice Total assets under management (t_0) - denominated in underlying asset units
    uint256 internal _totalAssets;

    /// @notice Deposit requests queue (D) - mapping of user address to requested [assets] amount
    EnumerableMap.AddressToUintMap private _depositRequests;

    /// @notice Redemption requests queue (R) - mapping of user address to requested [shares] amount
    EnumerableMap.AddressToUintMap private _redeemRequests;

    /// @notice Pending vault fees [assets]
    uint256 public pendingVaultFees;

    /// @notice Share token decimals
    uint8 public constant SHARE_DECIMALS = 18;

    /* -------------------------------------------------------------------------- */
    /*                               VAULT FEES                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Number of seconds in a year
    uint32 public constant YEAR_IN_SECONDS = 365 days;
    /// @notice Basis points factor (100% = 10_000)
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;
    /// @notice Maximum management fee (3% = 300)
    uint16 public constant MAX_MANAGEMENT_FEE = 300;
    /// @notice Maximum performance fee (30% = 3_000)
    uint16 public constant MAX_PERFORMANCE_FEE = 3_000;

    /// @notice Fee model
    FeeModel public feeModel;

    /// @notice Timestamp when new fee rates become effective
    uint256 public newFeeRatesTimestamp;

    /// @notice Previous fee model (used during cooldown period)
    FeeModel private oldFeeModel;

    /// @notice Flag indicating if the vault is in decommissioning mode
    /// @dev When true, intent is overridden to 100% underlying asset
    bool public isDecommissioning;

    /// @dev Restricts function to only vault manager
    modifier onlyManager() {
        if (msg.sender != manager) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only vault strategist
    modifier onlyStrategist() {
        if (msg.sender != strategist) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only liquidity orchestrator
    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only Orion Config contract
    modifier onlyConfig() {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the vault
    /// @param manager_ The address of the vault manager
    /// @param strategist_ The address of the vault strategist
    /// @param config_ The address of the OrionConfig contract
    /// @param name_ The name of the vault
    /// @param symbol_ The symbol of the vault
    /// @param feeType_ The fee type
    /// @param performanceFee_ The performance fee
    /// @param managementFee_ The management fee
    /// @param depositAccessControl_ The address of the deposit access control contract (address(0) = permissionless)
    // solhint-disable-next-line func-name-mixedcase, use-natspec
    function __OrionVault_init(
        address manager_,
        address strategist_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_,
        uint8 feeType_,
        uint16 performanceFee_,
        uint16 managementFee_,
        address depositAccessControl_
    ) internal onlyInitializing {
        // Initialize parent contracts
        __ERC20_init(name_, symbol_);
        __ERC4626_init(config_.underlyingAsset());
        __ReentrancyGuard_init();

        manager = manager_;
        strategist = strategist_;
        config = config_;
        liquidityOrchestrator = ILiquidityOrchestrator(config_.liquidityOrchestrator());
        depositAccessControl = depositAccessControl_;

        uint8 underlyingDecimals = IERC20Metadata(address(config_.underlyingAsset())).decimals();
        if (underlyingDecimals > SHARE_DECIMALS) revert ErrorsLib.InvalidUnderlyingDecimals();

        // Validate input
        if (feeType_ > uint8(FeeType.HURDLE_HWM)) revert ErrorsLib.InvalidArguments();
        if (performanceFee_ > MAX_PERFORMANCE_FEE) revert ErrorsLib.InvalidArguments();
        if (managementFee_ > MAX_MANAGEMENT_FEE) revert ErrorsLib.InvalidArguments();

        feeModel.feeType = FeeType(feeType_);
        feeModel.performanceFee = performanceFee_;
        feeModel.managementFee = managementFee_;

        feeModel.highWaterMark = 10 ** underlyingDecimals;

        oldFeeModel = feeModel;
        newFeeRatesTimestamp = block.timestamp;

        _initializeVaultWhitelist();
    }

    /// @notice Initialize the vault whitelist with all protocol whitelisted assets
    /// @dev This sets the initial vault whitelist to match the protocol whitelist as a default.
    ///      This can be overridden by the vault manager to set a subset of the protocol whitelist.
    function _initializeVaultWhitelist() internal {
        address[] memory protocolAssets = config.getAllWhitelistedAssets();
        for (uint256 i = 0; i < protocolAssets.length; ++i) {
            // slither-disable-next-line unused-return
            _vaultWhitelistedAssets.add(protocolAssets[i]);
        }
    }

    /// @inheritdoc IERC4626
    function deposit(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert SynchronousCallDisabled();
    }

    /// @inheritdoc IERC4626
    function mint(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert SynchronousCallDisabled();
    }

    /// @inheritdoc IERC4626
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override(ERC4626Upgradeable, IERC4626) nonReentrant returns (uint256) {
        // Only allow synchronous redemption for decommissioned vaults
        if (!config.isDecommissionedVault(address(this))) revert SynchronousCallDisabled();

        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) {
            revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        }
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        uint256 assets = previewRedeem(shares);
        // Update total assets accounting
        _totalAssets -= assets;

        _burn(owner, shares);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);

        liquidityOrchestrator.withdraw(assets, receiver);

        return assets;
    }

    /// @inheritdoc IERC4626
    function withdraw(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert SynchronousCallDisabled();
    }

    /// @inheritdoc IERC4626
    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _totalAssets;
    }

    /// @notice Override ERC4626 decimals to always use SHARE_DECIMALS regardless of underlying asset decimals
    /// @dev This ensures consistent 18-decimal precision for share tokens across all vaults
    /// @return SHARE_DECIMALS for all vault share tokens
    function decimals() public view virtual override(ERC4626Upgradeable, IERC20Metadata) returns (uint8) {
        return SHARE_DECIMALS;
    }

    /// @notice Override ERC4626 decimals offset to match our custom decimals implementation
    /// @dev Since we override decimals() to return SHARE_DECIMALS, we need to override _decimalsOffset()
    ///      to return the difference between SHARE_DECIMALS and underlying asset decimals
    /// @return The decimals offset for virtual shares/assets calculation
    function _decimalsOffset() internal view virtual override returns (uint8) {
        uint8 underlyingDecimals = IERC20Metadata(asset()).decimals();
        return SHARE_DECIMALS - underlyingDecimals;
    }

    /* ---------- CONVERSION FUNCTIONS ---------- */

    /// @inheritdoc IOrionVault
    function convertToAssetsWithPITTotalAssets(
        uint256 shares,
        uint256 pointInTimeTotalAssets,
        Math.Rounding rounding
    ) public view returns (uint256) {
        return shares.mulDiv(pointInTimeTotalAssets + 1, totalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    /// @notice Internal version that uses a snapshot of totalSupply for batch processing
    /// @param assets The assets to convert
    /// @param pointInTimeTotalAssets The point-in-time total assets
    /// @param snapshotTotalSupply The snapshot of totalSupply at batch start
    /// @param rounding The rounding mode
    /// @return The shares equivalent to the assets
    function _convertToSharesWithPITTotalAssets(
        uint256 assets,
        uint256 pointInTimeTotalAssets,
        uint256 snapshotTotalSupply,
        Math.Rounding rounding
    ) internal view returns (uint256) {
        return assets.mulDiv(snapshotTotalSupply + 10 ** _decimalsOffset(), pointInTimeTotalAssets + 1, rounding);
    }

    /// @notice Internal version that uses a snapshot of totalSupply for batch processing
    /// @param shares The shares to convert
    /// @param pointInTimeTotalAssets The point-in-time total assets
    /// @param snapshotTotalSupply The snapshot of totalSupply at batch start
    /// @param rounding The rounding mode
    /// @return The assets equivalent to the shares
    function _convertToAssetsWithPITTotalAssets(
        uint256 shares,
        uint256 pointInTimeTotalAssets,
        uint256 snapshotTotalSupply,
        Math.Rounding rounding
    ) internal view returns (uint256) {
        return shares.mulDiv(pointInTimeTotalAssets + 1, snapshotTotalSupply + 10 ** _decimalsOffset(), rounding);
    }

    /// --------- CONFIG FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function overrideIntentForDecommissioning() external onlyConfig {
        isDecommissioning = true;
    }

    /// @inheritdoc IOrionVault
    function implementation() external view returns (address) {
        bytes32 beaconSlot = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
        address beacon = StorageSlot.getAddressSlot(beaconSlot).value;
        if (beacon == address(0)) {
            return address(0);
        }
        return IBeacon(beacon).implementation();
    }

    /// --------- LP FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function requestDeposit(uint256 assets) external nonReentrant {
        if (depositAccessControl != address(0)) {
            if (!IOrionAccessControl(depositAccessControl).canRequestDeposit(msg.sender))
                revert ErrorsLib.DepositNotAllowed();
        }

        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (isDecommissioning || config.isDecommissionedVault(address(this))) revert ErrorsLib.VaultDecommissioned();
        if (assets == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        uint256 minDeposit = config.minDepositAmount();
        if (assets < minDeposit) revert ErrorsLib.BelowMinimumDeposit(assets, minDeposit);

        uint256 senderBalance = IERC20(asset()).balanceOf(msg.sender);
        if (assets > senderBalance) revert ErrorsLib.InsufficientAmount();

        IERC20(asset()).safeTransferFrom(msg.sender, address(liquidityOrchestrator), assets);

        // slither-disable-next-line unused-return
        (, uint256 currentAmount) = _depositRequests.tryGet(msg.sender);
        // slither-disable-next-line unused-return
        _depositRequests.set(msg.sender, currentAmount + assets);

        emit DepositRequest(msg.sender, assets);
    }

    /// @inheritdoc IOrionVault
    function cancelDepositRequest(uint256 amount) external nonReentrant {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        // slither-disable-next-line unused-return
        (, uint256 currentAmount) = _depositRequests.tryGet(msg.sender);
        if (currentAmount < amount) revert ErrorsLib.InsufficientAmount();

        // Update internal state
        uint256 newAmount = currentAmount - amount;

        if (newAmount == 0) {
            // slither-disable-next-line unused-return
            _depositRequests.remove(msg.sender);
        } else {
            // Avoid dust deposit requests by rejecting cancellations with small reminders.
            uint256 minDeposit = config.minDepositAmount();
            if (newAmount < minDeposit) revert ErrorsLib.BelowMinimumDeposit(newAmount, minDeposit);

            // slither-disable-next-line unused-return
            _depositRequests.set(msg.sender, newAmount);
        }

        // Request funds from liquidity orchestrator
        liquidityOrchestrator.returnDepositFunds(msg.sender, amount);

        emit DepositRequestCancelled(msg.sender, amount);
    }

    /// @inheritdoc IOrionVault
    function requestRedeem(uint256 shares) external nonReentrant {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (isDecommissioning || config.isDecommissionedVault(address(this))) revert ErrorsLib.VaultDecommissioned();
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        uint256 minRedeem = config.minRedeemAmount();
        if (shares < minRedeem) revert ErrorsLib.BelowMinimumRedeem(shares, minRedeem);

        uint256 senderBalance = balanceOf(msg.sender);
        if (shares > senderBalance) revert ErrorsLib.InsufficientAmount();

        IERC20(address(this)).safeTransferFrom(msg.sender, address(this), shares);

        // slither-disable-next-line unused-return
        (, uint256 currentShares) = _redeemRequests.tryGet(msg.sender);
        // slither-disable-next-line unused-return
        _redeemRequests.set(msg.sender, currentShares + shares);

        emit RedeemRequest(msg.sender, shares);
    }

    /// @inheritdoc IOrionVault
    function cancelRedeemRequest(uint256 shares) external nonReentrant {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        // slither-disable-next-line unused-return
        (, uint256 currentShares) = _redeemRequests.tryGet(msg.sender);
        if (currentShares < shares) revert ErrorsLib.InsufficientAmount();

        // Effects - update internal state
        uint256 newShares = currentShares - shares;
        if (newShares == 0) {
            // slither-disable-next-line unused-return
            _redeemRequests.remove(msg.sender);
        } else {
            // Avoid dust redeem requests by rejecting cancellations with small reminders.
            uint256 minRedeem = config.minRedeemAmount();
            if (newShares < minRedeem) revert ErrorsLib.BelowMinimumRedeem(newShares, minRedeem);

            // slither-disable-next-line unused-return
            _redeemRequests.set(msg.sender, newShares);
        }

        // Interactions - return shares to LP.
        IERC20(address(this)).safeTransfer(msg.sender, shares);

        emit RedeemRequestCancelled(msg.sender, shares);
    }

    /// --------- MANAGER AND STRATEGIST FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function vaultWhitelist() external view returns (address[] memory) {
        return _vaultWhitelistedAssets.values();
    }

    /// @inheritdoc IOrionVault
    function updateStrategist(address newStrategist) external onlyManager {
        strategist = newStrategist;
        emit StrategistUpdated(newStrategist);
    }

    /// @inheritdoc IOrionVault
    function setDepositAccessControl(address newDepositAccessControl) external onlyManager {
        // No extra checks, manager has right to fully stop deposits
        depositAccessControl = newDepositAccessControl;
        emit DepositAccessControlUpdated(newDepositAccessControl);
    }

    /// @inheritdoc IOrionVault
    function updateVaultWhitelist(address[] calldata assets) external onlyManager {
        // Clear existing whitelist
        _vaultWhitelistedAssets.clear();

        for (uint256 i = 0; i < assets.length; ++i) {
            address token = assets[i];

            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);

            bool inserted = _vaultWhitelistedAssets.add(token);
            if (!inserted) revert ErrorsLib.AlreadyRegistered();
        }

        if (!_vaultWhitelistedAssets.contains(this.asset())) {
            // slither-disable-next-line unused-return
            _vaultWhitelistedAssets.add(this.asset());
        }

        emit VaultWhitelistUpdated(assets);
    }

    /// @notice Update the fee model parameters with cooldown protection
    /// @param feeType The fee type (0=ABSOLUTE, 1=HURDLE, 2=HIGH_WATER_MARK, 3=HURDLE_HWM)
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @dev Only vault manager can update fee model parameters
    ///      Performance and management fees are capped by protocol limits
    ///      New fees take effect after cooldown period to protect depositors
    function updateFeeModel(uint8 feeType, uint16 performanceFee, uint16 managementFee) external onlyManager {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Validate input
        if (feeType > uint8(FeeType.HURDLE_HWM)) revert ErrorsLib.InvalidArguments();
        if (performanceFee > MAX_PERFORMANCE_FEE) revert ErrorsLib.InvalidArguments();
        if (managementFee > MAX_MANAGEMENT_FEE) revert ErrorsLib.InvalidArguments();

        // Store old fee model for cooldown period
        oldFeeModel = activeFeeModel();

        // Update to new fee model immediately in storage
        feeModel.feeType = FeeType(feeType);
        feeModel.performanceFee = performanceFee;
        feeModel.managementFee = managementFee;

        // Set when new rates become effective
        newFeeRatesTimestamp = block.timestamp + config.feeChangeCooldownDuration();

        emit EventsLib.VaultFeeChangeScheduled(feeType, performanceFee, managementFee, newFeeRatesTimestamp);
    }

    /// @inheritdoc IOrionVault
    function activeFeeModel() public view returns (FeeModel memory) {
        // If we're still in cooldown period, return old rates
        if (newFeeRatesTimestamp > block.timestamp) {
            return oldFeeModel;
        }
        // Otherwise return new rates
        return feeModel;
    }

    /// @notice Validate that all assets in an intent are whitelisted for this vault
    /// @param assets Array of asset addresses to validate
    function _validateIntentAssets(address[] memory assets) internal view {
        for (uint256 i = 0; i < assets.length; ++i) {
            if (!_vaultWhitelistedAssets.contains(assets[i])) {
                revert ErrorsLib.TokenNotWhitelisted(assets[i]);
            }
        }
    }

    /// @inheritdoc IOrionVault
    function vaultFee(
        uint256 activeTotalAssets,
        FeeModel calldata snapshotFeeModel
    ) external view returns (uint256 managementFee, uint256 performanceFee) {
        managementFee = _managementFeeAmount(activeTotalAssets, snapshotFeeModel);
        uint256 intermediateTotalAssets = activeTotalAssets - managementFee;
        performanceFee = _performanceFeeAmount(intermediateTotalAssets, snapshotFeeModel);
    }

    /// @notice Calculate management fee amount
    /// @param feeTotalAssets The total assets to calculate management fee for
    /// @param snapshotFeeModel The fee model to use for calculation
    /// @return The management fee amount in underlying asset units
    function _managementFeeAmount(
        uint256 feeTotalAssets,
        FeeModel calldata snapshotFeeModel
    ) internal view returns (uint256) {
        if (snapshotFeeModel.managementFee == 0) return 0;

        uint256 annualFeeAmount = uint256(snapshotFeeModel.managementFee).mulDiv(feeTotalAssets, BASIS_POINTS_FACTOR);
        return annualFeeAmount.mulDiv(liquidityOrchestrator.epochDuration(), YEAR_IN_SECONDS);
    }

    /// @notice Calculate performance fee amount
    /// @dev Performance fee calculation depends on the FeeType
    /// @param feeTotalAssets The total assets to calculate performance fee for
    /// @param snapshotFeeModel The fee model to use for calculation
    /// @return The performance fee amount in underlying asset units
    function _performanceFeeAmount(
        uint256 feeTotalAssets,
        FeeModel calldata snapshotFeeModel
    ) internal view returns (uint256) {
        if (snapshotFeeModel.performanceFee == 0) return 0;

        uint256 activeSharePrice = convertToAssetsWithPITTotalAssets(
            10 ** decimals(),
            feeTotalAssets,
            Math.Rounding.Floor
        );

        (uint256 benchmark, uint256 divisor) = _getBenchmark(snapshotFeeModel.feeType, snapshotFeeModel.highWaterMark);

        if (activeSharePrice < benchmark || divisor == 0) return 0;
        uint256 feeRate = uint256(snapshotFeeModel.performanceFee).mulDiv(activeSharePrice - divisor, divisor);
        uint256 performanceFeeAmount = feeRate.mulDiv(feeTotalAssets, BASIS_POINTS_FACTOR);
        return performanceFeeAmount.mulDiv(liquidityOrchestrator.epochDuration(), YEAR_IN_SECONDS);
    }

    /// @notice Get benchmark value based on fee model type
    /// @param feeType The fee type to get benchmark for
    /// @param highWaterMark The high water mark value to use
    /// @return benchmark The benchmark value
    /// @return divisor The divisor value
    function _getBenchmark(
        FeeType feeType,
        uint256 highWaterMark
    ) internal view returns (uint256 benchmark, uint256 divisor) {
        uint256 currentSharePrice = convertToAssets(10 ** decimals());

        if (feeType == FeeType.ABSOLUTE) {
            benchmark = currentSharePrice;
            divisor = benchmark;
        } else if (feeType == FeeType.HIGH_WATER_MARK) {
            benchmark = highWaterMark;
            divisor = benchmark;
        } else if (feeType == FeeType.SOFT_HURDLE) {
            benchmark = _getHurdlePrice(currentSharePrice);
            divisor = currentSharePrice;
        } else if (feeType == FeeType.HARD_HURDLE) {
            benchmark = _getHurdlePrice(currentSharePrice);
            divisor = benchmark;
        } else if (feeType == FeeType.HURDLE_HWM) {
            benchmark = Math.max(highWaterMark, _getHurdlePrice(currentSharePrice));
            divisor = benchmark;
        }
        return (benchmark, divisor);
    }

    /// @notice Get hurdle price amount based on configured risk-free rate
    /// @param currentSharePrice The current share price to calculate hurdle from
    /// @return The hurdle price
    function _getHurdlePrice(uint256 currentSharePrice) internal view returns (uint256) {
        uint256 riskFreeRate = config.riskFreeRate();

        uint256 hurdleReturn = riskFreeRate.mulDiv(liquidityOrchestrator.epochDuration(), YEAR_IN_SECONDS);
        return currentSharePrice.mulDiv(BASIS_POINTS_FACTOR + hurdleReturn, BASIS_POINTS_FACTOR);
    }

    /// @inheritdoc IOrionVault
    function claimVaultFees(uint256 amount) external onlyManager {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());
        if (amount > pendingVaultFees) revert ErrorsLib.InsufficientAmount();

        pendingVaultFees -= amount;
        liquidityOrchestrator.transferVaultFees(amount);

        emit VaultFeesClaimed(msg.sender, amount);
    }

    /// --------- INTERNAL STATE ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function pendingDeposit(uint256 fulfillBatchSize) external view returns (uint256) {
        uint256 length = _depositRequests.length();
        if (length == 0) {
            return 0;
        }

        uint256 batchSize = Math.min(length, fulfillBatchSize);
        uint256 processableAmount = 0;

        for (uint16 i = 0; i < batchSize; ++i) {
            // slither-disable-next-line unused-return
            (, uint256 amount) = _depositRequests.at(i);
            processableAmount += amount;
        }

        return processableAmount;
    }

    /// @inheritdoc IOrionVault
    function pendingRedeem(uint256 fulfillBatchSize) external view returns (uint256) {
        uint256 length = _redeemRequests.length();
        if (length == 0) {
            return 0;
        }

        uint256 batchSize = Math.min(length, fulfillBatchSize);
        uint256 processableShares = 0;

        for (uint16 i = 0; i < batchSize; ++i) {
            // slither-disable-next-line unused-return
            (, uint256 shares) = _redeemRequests.at(i);
            processableShares += shares;
        }

        return processableShares;
    }

    /// @inheritdoc IOrionVault
    function accrueVaultFees(uint256 managementFee, uint256 performanceFee) external onlyLiquidityOrchestrator {
        if (managementFee == 0 && performanceFee == 0) return;

        uint256 totalFee = managementFee + performanceFee;
        pendingVaultFees += totalFee;

        emit VaultFeesAccrued(managementFee, performanceFee);
    }

    /// @inheritdoc IOrionVault
    function fulfillDeposit(uint256 depositTotalAssets) external onlyLiquidityOrchestrator nonReentrant {
        uint256 length = _depositRequests.length();
        if (length == 0) {
            return;
        }

        uint256 batchSize = Math.min(length, config.maxFulfillBatchSize());

        // Capture totalSupply snapshot to ensure consistent pricing for all users in this batch
        uint256 snapshotTotalSupply = totalSupply();

        address[] memory users = new address[](batchSize);
        uint256[] memory amounts = new uint256[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            (users[i], amounts[i]) = _depositRequests.at(i);
        }

        // Process requests in batch
        uint256 processedAmount = 0;
        for (uint256 i = 0; i < batchSize; ++i) {
            address user = users[i];
            uint256 amount = amounts[i];

            // slither-disable-next-line unused-return
            _depositRequests.remove(user);

            uint256 shares = _convertToSharesWithPITTotalAssets(
                amount,
                depositTotalAssets,
                snapshotTotalSupply,
                Math.Rounding.Floor
            );
            _mint(user, shares);
            processedAmount += amount;

            emit Deposit(user, user, amount, shares);
        }
    }

    /// @inheritdoc IOrionVault
    function fulfillRedeem(uint256 redeemTotalAssets) external onlyLiquidityOrchestrator nonReentrant {
        uint256 length = _redeemRequests.length();
        if (length == 0) {
            return;
        }

        uint256 batchSize = Math.min(length, config.maxFulfillBatchSize());

        // Capture totalSupply snapshot to ensure consistent pricing for all users in this batch
        uint256 snapshotTotalSupply = totalSupply();

        // Collect all keys to process first to avoid swap-and-pop reordering issues
        address[] memory users = new address[](batchSize);
        uint256[] memory shares = new uint256[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            (users[i], shares[i]) = _redeemRequests.at(i);
        }

        // Process requests in batch
        uint256 processedShares = 0;
        for (uint256 i = 0; i < batchSize; ++i) {
            address user = users[i];
            uint256 userShares = shares[i];

            // slither-disable-next-line unused-return
            _redeemRequests.remove(user);

            uint256 underlyingAmount = _convertToAssetsWithPITTotalAssets(
                userShares,
                redeemTotalAssets,
                snapshotTotalSupply,
                Math.Rounding.Floor
            );
            _burn(address(this), userShares);
            processedShares += userShares;

            // Transfer underlying assets from liquidity orchestrator to the user
            liquidityOrchestrator.transferRedemptionFunds(user, underlyingAmount);

            emit Redeem(user, underlyingAmount, userShares);
        }
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
