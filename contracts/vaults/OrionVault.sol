// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import "@openzeppelin/contracts/utils/StorageSlot.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/ILiquidityOrchestrator.sol";
import "../interfaces/IOrionAccessControl.sol";
import "../interfaces/IOrionStrategist.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
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
abstract contract OrionVault is Initializable, ERC4626Upgradeable, ReentrancyGuardTransient, IOrionVault {
    using Math for uint256;
    using SafeERC20 for IERC20;

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

    /// @notice Total assets under management (t_0) - denominated in underlying asset units
    uint256 internal _totalAssets;

    /// @dev Reserved slots: replaced EnumerableMap deposit queue (3 slots, preserved for upgrade safety).
    uint256[3] private __depositRequestsGap;
    /// @dev Reserved slots: replaced EnumerableMap redeem queue (3 slots, preserved for upgrade safety).
    uint256[3] private __redeemRequestsGap;

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

    /// @notice Fee model
    FeeModel public feeModel;

    /// @notice Timestamp when new fee rates become effective
    uint256 public newFeeRatesTimestamp;

    /// @notice Previous fee model (used during cooldown period)
    FeeModel internal oldFeeModel;

    /// @notice Flag indicating if the vault is in decommissioning mode
    /// @dev When true, intent is overridden to 100% underlying asset
    bool public isDecommissioning;

    /// @notice Underlying amount owed to a user whose redemption transfer failed (e.g. USDC denylist)
    mapping(address => uint256) public pendingUnderlyingClaims;

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

        manager = manager_;
        strategist = strategist_;
        config = config_;
        liquidityOrchestrator = ILiquidityOrchestrator(config_.liquidityOrchestrator());
        depositAccessControl = depositAccessControl_;

        uint8 underlyingDecimals = IERC20Metadata(address(config_.underlyingAsset())).decimals();
        if (underlyingDecimals > SHARE_DECIMALS) revert ErrorsLib.InvalidUnderlyingDecimals();

        // Validate input
        if (feeType_ > uint8(FeeType.HURDLE_HWM)) revert ErrorsLib.InvalidArguments();

        feeModel.feeType = FeeType(feeType_);
        feeModel.performanceFee = performanceFee_;
        feeModel.managementFee = managementFee_;

        feeModel.highWaterMark = 10 ** underlyingDecimals;

        oldFeeModel = feeModel;
        newFeeRatesTimestamp = block.timestamp;
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
        _enqueueDeposit(msg.sender, assets);

        emit DepositRequest(msg.sender, assets);
    }

    /// @dev Adds `amount` to the user's deposit queue slot. Subsequent calls accumulate into
    ///      the same slot, preserving the user's original queue position. Slots are 1-indexed;
    ///      ticket value 0 is the sentinel for "not queued".
    function _enqueueDeposit(address user, uint256 amount) private {
        uint256 ticket = _depositTicket[user];
        if (ticket != 0) {
            _depositQueueAmount[ticket] += amount;
            return;
        }
        uint256 slot = (_depositTail == 0) ? 1 : _depositTail;
        _depositTail = slot + 1;
        if (_depositHead == 0) _depositHead = slot;
        _depositQueueUser[slot] = user;
        _depositQueueAmount[slot] = amount;
        _depositTicket[user] = slot;
        ++_depositCount;
    }

    /// @inheritdoc IOrionVault
    function cancelDepositRequest(uint256 amount) external nonReentrant {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        uint256 ticket = _depositTicket[msg.sender];
        if (ticket == 0) revert ErrorsLib.InsufficientAmount();

        uint256 currentAmount = _depositQueueAmount[ticket];
        if (currentAmount < amount) revert ErrorsLib.InsufficientAmount();

        uint256 newAmount = currentAmount - amount;

        if (newAmount == 0) {
            _depositQueueUser[ticket] = address(0);
            _depositQueueAmount[ticket] = 0;
            delete _depositTicket[msg.sender];
            --_depositCount;
        } else {
            uint256 minDeposit = config.minDepositAmount();
            if (newAmount < minDeposit) revert ErrorsLib.BelowMinimumDeposit(newAmount, minDeposit);
            _depositQueueAmount[ticket] = newAmount;
        }

        liquidityOrchestrator.returnDepositFunds(msg.sender, amount);

        emit DepositRequestCancelled(msg.sender, amount);
    }

    /// @inheritdoc IOrionVault
    function requestRedeem(uint256 shares) external nonReentrant {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (config.isDecommissionedVault(address(this))) revert ErrorsLib.VaultDecommissioned();
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        uint256 minRedeem = config.minRedeemAmount();
        if (shares < minRedeem) revert ErrorsLib.BelowMinimumRedeem(shares, minRedeem);

        uint256 senderBalance = balanceOf(msg.sender);
        if (shares > senderBalance) revert ErrorsLib.InsufficientAmount();

        IERC20(address(this)).safeTransferFrom(msg.sender, address(this), shares);
        _enqueueRedeem(msg.sender, shares);

        emit RedeemRequest(msg.sender, shares);
    }

    /// @dev Adds `amount` to the user's redeem queue slot. Subsequent calls accumulate into
    ///      the same slot, preserving the user's original queue position. Slots are 1-indexed;
    ///      ticket value 0 is the sentinel for "not queued".
    function _enqueueRedeem(address user, uint256 amount) private {
        uint256 ticket = _redeemTicket[user];
        if (ticket != 0) {
            _redeemQueueAmount[ticket] += amount;
            return;
        }
        uint256 slot = (_redeemTail == 0) ? 1 : _redeemTail;
        _redeemTail = slot + 1;
        if (_redeemHead == 0) _redeemHead = slot;
        _redeemQueueUser[slot] = user;
        _redeemQueueAmount[slot] = amount;
        _redeemTicket[user] = slot;
        ++_redeemCount;
    }

    /// @inheritdoc IOrionVault
    function cancelRedeemRequest(uint256 shares) external nonReentrant {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        uint256 ticket = _redeemTicket[msg.sender];
        if (ticket == 0) revert ErrorsLib.InsufficientAmount();

        uint256 currentShares = _redeemQueueAmount[ticket];
        if (currentShares < shares) revert ErrorsLib.InsufficientAmount();

        uint256 newShares = currentShares - shares;
        if (newShares == 0) {
            _redeemQueueUser[ticket] = address(0);
            _redeemQueueAmount[ticket] = 0;
            delete _redeemTicket[msg.sender];
            --_redeemCount;
        } else {
            uint256 minRedeem = config.minRedeemAmount();
            if (newShares < minRedeem) revert ErrorsLib.BelowMinimumRedeem(newShares, minRedeem);
            _redeemQueueAmount[ticket] = newShares;
        }

        IERC20(address(this)).safeTransfer(msg.sender, shares);

        emit RedeemRequestCancelled(msg.sender, shares);
    }

    /// --------- MANAGER AND STRATEGIST FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function updateStrategist(address newStrategist) external onlyManager {
        strategist = newStrategist;
        _linkStrategistVault(newStrategist);
        emit StrategistUpdated(newStrategist);
    }

    /// @dev Tells on-chain strategists which vault they manage; skips EOAs and wallets that are not Orion strategists.
    function _linkStrategistVault(address strategist_) internal {
        if (strategist_.code.length == 0) return;
        try IERC165(strategist_).supportsInterface(type(IOrionStrategist).interfaceId) returns (bool supported) {
            if (supported) {
                IOrionStrategist(strategist_).setVault(address(this));
            }
        } catch {}
    }

    /// @inheritdoc IOrionVault
    function setDepositAccessControl(address newDepositAccessControl) external onlyManager {
        // No extra checks, manager has right to fully stop deposits
        depositAccessControl = newDepositAccessControl;
        emit DepositAccessControlUpdated(newDepositAccessControl);
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

    /// @notice Validate that all assets in an intent are whitelisted
    /// @param assets Array of asset addresses to validate
    function _validateIntentAssets(address[] memory assets) internal view {
        for (uint256 i = 0; i < assets.length; ++i) {
            if (!config.isWhitelisted(assets[i])) revert ErrorsLib.TokenNotWhitelisted(assets[i]);
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
        if (snapshotFeeModel.performanceFee == 0 || feeTotalAssets == 0) return 0;

        uint256 activeSharePrice = convertToAssetsWithPITTotalAssets(
            10 ** decimals(),
            feeTotalAssets,
            Math.Rounding.Floor
        );
        if (activeSharePrice == 0) return 0;

        uint16 perfBps = snapshotFeeModel.performanceFee;
        FeeType feeType = snapshotFeeModel.feeType;
        if (feeType == FeeType.SOFT_HURDLE) {
            return _performanceFeeAmountSoftHurdle(activeSharePrice, feeTotalAssets, perfBps);
        }
        return
            _performanceFeeAmountNonSoft(
                activeSharePrice,
                feeTotalAssets,
                perfBps,
                feeType,
                snapshotFeeModel.highWaterMark
            );
    }

    function _performanceFeeAmountNonSoft(
        uint256 activeSharePrice,
        uint256 feeTotalAssets,
        uint16 perfBps,
        FeeType feeType,
        uint256 highWaterMark
    ) internal view returns (uint256) {
        uint256 benchmark = _performanceFeeBenchmark(feeType, highWaterMark);
        if (activeSharePrice <= benchmark) return 0;

        uint256 profitsInAssets = (activeSharePrice - benchmark).mulDiv(feeTotalAssets, activeSharePrice);
        return _annualizedPerformanceFee(profitsInAssets, perfBps);
    }

    function _performanceFeeAmountSoftHurdle(
        uint256 activeSharePrice,
        uint256 feeTotalAssets,
        uint16 perfBps
    ) internal view returns (uint256) {
        uint256 spotSharePrice = convertToAssets(10 ** decimals());

        uint256 hurdle = _getHurdlePrice(spotSharePrice);
        if (activeSharePrice <= hurdle) return 0;

        uint256 profitsInAssets = (activeSharePrice - spotSharePrice).mulDiv(feeTotalAssets, activeSharePrice);
        return _annualizedPerformanceFee(profitsInAssets, perfBps);
    }

    function _annualizedPerformanceFee(uint256 profitsInAssets, uint16 perfBps) internal view returns (uint256) {
        uint256 epochProfits = profitsInAssets.mulDiv(liquidityOrchestrator.epochDuration(), YEAR_IN_SECONDS);
        return uint256(perfBps).mulDiv(epochProfits, BASIS_POINTS_FACTOR);
    }

    /// @notice Share-price benchmark used as both gate and profit baseline.
    /// @param feeType Active fee model
    /// @param highWaterMark Stored HWM (same units as share price)
    /// @return benchmark Assets per share threshold; profits are measured from this level upward.
    function _performanceFeeBenchmark(
        FeeType feeType,
        uint256 highWaterMark
    ) internal view returns (uint256 benchmark) {
        uint256 currentSharePrice = convertToAssets(10 ** decimals());

        if (feeType == FeeType.ABSOLUTE) {
            benchmark = currentSharePrice;
        } else if (feeType == FeeType.HIGH_WATER_MARK) {
            benchmark = highWaterMark;
        } else if (feeType == FeeType.HARD_HURDLE) {
            benchmark = _getHurdlePrice(currentSharePrice);
        } else if (feeType == FeeType.HURDLE_HWM) {
            benchmark = Math.max(highWaterMark, _getHurdlePrice(currentSharePrice));
        }
        return benchmark;
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
        if (_depositCount == 0) return 0;
        uint256 found = 0;
        uint256 total = 0;
        for (uint256 i = _depositHead; i < _depositTail && found < fulfillBatchSize; ++i) {
            if (_depositQueueUser[i] == address(0)) continue;
            total += _depositQueueAmount[i];
            ++found;
        }
        return total;
    }

    /// @inheritdoc IOrionVault
    function pendingRedeem(uint256 fulfillBatchSize) external view returns (uint256) {
        if (_redeemCount == 0) return 0;
        uint256 found = 0;
        uint256 total = 0;
        for (uint256 i = _redeemHead; i < _redeemTail && found < fulfillBatchSize; ++i) {
            if (_redeemQueueUser[i] == address(0)) continue;
            total += _redeemQueueAmount[i];
            ++found;
        }
        return total;
    }

    /// @inheritdoc IOrionVault
    function pendingDepositCount() external view returns (uint256) {
        return _depositCount;
    }

    /// @inheritdoc IOrionVault
    function pendingRedeemCount() external view returns (uint256) {
        return _redeemCount;
    }

    /// @inheritdoc IOrionVault
    function pendingRedeemBatch(uint256 fulfillBatchSize) external view returns (address[] memory, uint256[] memory) {
        if (_redeemCount == 0) return (new address[](0), new uint256[](0));
        uint256 batchSize = Math.min(_redeemCount, fulfillBatchSize);
        address[] memory users = new address[](batchSize);
        uint256[] memory shares = new uint256[](batchSize);
        uint256 found = 0;
        for (uint256 i = _redeemHead; i < _redeemTail && found < batchSize; ++i) {
            if (_redeemQueueUser[i] == address(0)) continue;
            users[found] = _redeemQueueUser[i];
            shares[found] = _redeemQueueAmount[i];
            ++found;
        }
        return (users, shares);
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
        if (_depositCount == 0) return;

        uint256 batchSize = Math.min(_depositCount, config.maxFulfillBatchSize());

        uint256 snapshotTotalSupply = totalSupply();

        uint256 found = 0;
        uint256 cursor = _depositHead;
        while (found < batchSize && cursor < _depositTail) {
            address user = _depositQueueUser[cursor];
            if (user == address(0)) {
                ++cursor;
                continue;
            }

            uint256 amount = _depositQueueAmount[cursor];

            _depositQueueUser[cursor] = address(0);
            _depositQueueAmount[cursor] = 0;
            delete _depositTicket[user];
            --_depositCount;
            ++cursor;

            uint256 shares = _convertToSharesWithPITTotalAssets(
                amount,
                depositTotalAssets,
                snapshotTotalSupply,
                Math.Rounding.Floor
            );
            _mint(user, shares);
            ++found;

            emit Deposit(user, user, amount, shares);
        }
        _depositHead = cursor;
    }

    /// @inheritdoc IOrionVault
    function fulfillRedeem(uint256 redeemTotalAssets) external onlyLiquidityOrchestrator nonReentrant {
        if (_redeemCount == 0) return;

        uint256 batchSize = Math.min(_redeemCount, config.maxFulfillBatchSize());

        uint256 snapshotTotalSupply = totalSupply();

        uint256 found = 0;
        uint256 processedShares = 0;
        uint256 cursor = _redeemHead;
        while (found < batchSize && cursor < _redeemTail) {
            address user = _redeemQueueUser[cursor];
            if (user == address(0)) {
                ++cursor;
                continue;
            }

            uint256 userShares = _redeemQueueAmount[cursor];

            _redeemQueueUser[cursor] = address(0);
            _redeemQueueAmount[cursor] = 0;
            delete _redeemTicket[user];
            --_redeemCount;
            ++cursor;

            uint256 underlyingAmount = _convertToAssetsWithPITTotalAssets(
                userShares,
                redeemTotalAssets,
                snapshotTotalSupply,
                Math.Rounding.Floor
            );
            processedShares += userShares;
            ++found;

            try liquidityOrchestrator.transferRedemptionFunds(user, underlyingAmount) {
                emit Redeem(user, underlyingAmount, userShares);
            } catch {
                pendingUnderlyingClaims[user] += underlyingAmount;
                emit RedemptionTransferFailed(user, underlyingAmount);
            }
        }
        _redeemHead = cursor;
        _burn(address(this), processedShares);
    }

    /// @inheritdoc IOrionVault
    function claimUnderlying() external nonReentrant {
        uint256 amount = pendingUnderlyingClaims[msg.sender];
        if (amount == 0) revert ErrorsLib.InsufficientAmount();
        pendingUnderlyingClaims[msg.sender] = 0;
        liquidityOrchestrator.transferRedemptionFunds(msg.sender, amount);
        emit RedemptionClaimed(msg.sender, amount);
    }

    // ---- FIFO Deposit Queue ----
    /// @dev Index of the oldest unfulfilled deposit slot (1-indexed; 0 means empty).
    uint256 private _depositHead;
    /// @dev Next insertion slot index (exclusive upper bound).
    uint256 private _depositTail;
    /// @dev Slot index → depositor address (address(0) = cancelled slot).
    mapping(uint256 => address) private _depositQueueUser;
    /// @dev Slot index → pending deposit amount in underlying tokens.
    mapping(uint256 => uint256) private _depositQueueAmount;
    /// @dev User address → their current queue slot index (0 = not in queue).
    mapping(address => uint256) private _depositTicket;
    /// @dev Number of active (non-cancelled) deposit entries.
    uint256 private _depositCount;

    // ---- FIFO Redeem Queue ----
    /// @dev Index of the oldest unfulfilled redeem slot (1-indexed; 0 means empty).
    uint256 private _redeemHead;
    /// @dev Next insertion slot index (exclusive upper bound).
    uint256 private _redeemTail;
    /// @dev Slot index → redeemer address (address(0) = cancelled slot).
    mapping(uint256 => address) private _redeemQueueUser;
    /// @dev Slot index → pending redeem amount in vault shares.
    mapping(uint256 => uint256) private _redeemQueueAmount;
    /// @dev User address → their current queue slot index (0 = not in queue).
    mapping(address => uint256) private _redeemTicket;
    /// @dev Number of active (non-cancelled) redeem entries.
    uint256 private _redeemCount;

    /// @dev Storage gap (reduced by 12 for FIFO queue variables).
    uint256[37] private __gap;
}
