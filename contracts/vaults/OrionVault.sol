// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/ILiquidityOrchestrator.sol";
import "../interfaces/IOrionAccessControl.sol";
import "../interfaces/IOrionStrategist.sol";
import { ERC165Checker } from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
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
    using EnumerableMap for EnumerableMap.AddressToUintMap;

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

    /// @notice Fee model
    FeeModel public feeModel;

    /// @notice Timestamp when new fee rates become effective
    uint256 public newFeeRatesTimestamp;

    /// @notice Previous fee model (used during cooldown period)
    FeeModel internal oldFeeModel;

    /// @notice Flag indicating if the vault is in decommissioning mode
    /// @dev When true, intent is overridden to 100% underlying asset
    bool public isDecommissioning;

    struct PendingUnderlyingClaims {
        mapping(address => uint256) byUser;
        uint256 total;
    }

    PendingUnderlyingClaims private _pendingUnderlyingClaims;

    /// @notice Holder access control contract (address(0) = permissionless)
    address public holderAccessControl;
    /// @notice Transfer access control contract (address(0) = permissionless)
    address public transferAccessControl;

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
    /// @param depositAccessControl_ Deposit access control (address(0) = permissionless)
    /// @param holderAccessControl_ Holder access control (address(0) = permissionless)
    /// @param transferAccessControl_ Transfer access control (address(0) = permissionless)
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
        address depositAccessControl_,
        address holderAccessControl_,
        address transferAccessControl_
    ) internal onlyInitializing {
        // Initialize parent contracts
        __ERC20_init(name_, symbol_);
        __ERC4626_init(config_.underlyingAsset());

        manager = manager_;
        strategist = strategist_;
        config = config_;
        liquidityOrchestrator = ILiquidityOrchestrator(config_.liquidityOrchestrator());

        _requireValidAccessControl(depositAccessControl_, type(IOrionDepositAccessControl).interfaceId);
        _requireValidAccessControl(holderAccessControl_, type(IOrionHolderAccessControl).interfaceId);
        _requireValidAccessControl(transferAccessControl_, type(IOrionTransferAccessControl).interfaceId);
        depositAccessControl = depositAccessControl_;
        holderAccessControl = holderAccessControl_;
        transferAccessControl = transferAccessControl_;

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

    /// @inheritdoc IERC4626
    function maxDeposit(address receiver) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        if (!config.isSystemIdle()) return 0;
        if (isDecommissioning || config.isDecommissionedVault(address(this))) return 0;
        if (!_canRequestDeposit(receiver)) return 0;
        return type(uint256).max;
    }

    /// @inheritdoc IERC4626
    function maxMint(address receiver) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        uint256 maxAssets = maxDeposit(receiver);
        if (maxAssets == 0) return 0;
        return type(uint256).max;
    }

    /// @inheritdoc IERC4626
    function maxRedeem(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        if (config.isDecommissionedVault(address(this))) return balanceOf(owner);

        if (!config.isSystemIdle()) return 0;
        uint256 shares = balanceOf(owner);
        if (shares < config.minRedeemAmount()) return 0;
        return shares;
    }

    /// @inheritdoc IERC4626
    function maxWithdraw(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        uint256 maxShares = maxRedeem(owner);
        if (maxShares == 0) return 0;
        return convertToAssets(maxShares);
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

    /// --------- LP FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function requestDeposit(uint256 assets) external nonReentrant {
        _requestDeposit(msg.sender, assets);
    }

    /// @inheritdoc IOrionVault
    function requestDepositFor(address beneficiary, uint256 assets) external nonReentrant {
        if (beneficiary == address(0)) revert ErrorsLib.ZeroAddress();
        _requestDeposit(beneficiary, assets);
    }

    /// @dev Assets are pulled from msg.sender (e.g., router/depositor), but the deposit queue and
    /// eventual shares credit `beneficiary`. Deposit and holder access control lists are
    /// evaluated solely against `beneficiary`, not msg.sender.
    function _requestDeposit(address beneficiary, uint256 assets) internal {
        _requireCanRequestDeposit(beneficiary);

        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        if (isDecommissioning || config.isDecommissionedVault(address(this))) revert ErrorsLib.VaultDecommissioned();
        if (assets == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        uint256 minDeposit = config.minDepositAmount();
        if (assets < minDeposit) revert ErrorsLib.BelowMinimumDeposit(assets, minDeposit);

        if (assets > IERC20(asset()).balanceOf(msg.sender)) revert ErrorsLib.InsufficientAmount();

        IERC20(asset()).safeTransferFrom(msg.sender, address(liquidityOrchestrator), assets);

        // slither-disable-next-line unused-return
        (, uint256 currentAmount) = _depositRequests.tryGet(beneficiary);
        // slither-disable-next-line unused-return
        _depositRequests.set(beneficiary, currentAmount + assets);

        emit DepositRequest(beneficiary, assets);
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
        if (config.isDecommissionedVault(address(this))) revert ErrorsLib.VaultDecommissioned();
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
    function updateStrategist(address newStrategist) external onlyManager {
        strategist = newStrategist;
        _linkStrategistVault(newStrategist);
        emit StrategistUpdated(newStrategist);
    }

    /// @dev Tells onchain strategists which vault they manage; skips EOAs and non-compliant / non-strategist contracts.
    function _linkStrategistVault(address strategist_) internal {
        if (strategist_.code.length == 0) return;
        if (ERC165Checker.supportsInterface(strategist_, type(IOrionStrategist).interfaceId)) {
            IOrionStrategist(strategist_).setVault(address(this));
        }
    }

    /// @dev Rejects EOAs and contracts that fail ERC-165 compliance and do not support `interfaceId`.
    function _requireValidAccessControl(address accessControl, bytes4 interfaceId) internal view {
        if (accessControl == address(0)) return;
        if (accessControl.code.length == 0) revert ErrorsLib.InvalidAddress();
        if (!ERC165Checker.supportsInterface(accessControl, interfaceId)) revert ErrorsLib.InvalidAddress();
    }

    function _depositAccessControlAllows(address account) internal view returns (bool) {
        return
            depositAccessControl == address(0) ||
            IOrionDepositAccessControl(depositAccessControl).canRequestDeposit(account, msg.data);
    }

    function _holderAccessControlAllows(address account) internal view returns (bool) {
        return
            holderAccessControl == address(0) || IOrionHolderAccessControl(holderAccessControl).canHoldShares(account);
    }

    function _canRequestDeposit(address account) internal view returns (bool) {
        return _depositAccessControlAllows(account) && _holderAccessControlAllows(account);
    }

    function _requireCanRequestDeposit(address account) internal view {
        if (!_depositAccessControlAllows(account)) revert ErrorsLib.DepositNotAllowed();
        if (!_holderAccessControlAllows(account)) revert ErrorsLib.ShareHoldNotAllowed();
    }

    /// @inheritdoc IOrionVault
    function setDepositAccessControl(address newDepositAccessControl) external onlyManager {
        _requireValidAccessControl(newDepositAccessControl, type(IOrionDepositAccessControl).interfaceId);
        depositAccessControl = newDepositAccessControl;
        emit DepositAccessControlUpdated(newDepositAccessControl);
    }

    /// @inheritdoc IOrionVault
    function setHolderAccessControl(address newHolderAccessControl) external onlyManager {
        _requireValidAccessControl(newHolderAccessControl, type(IOrionHolderAccessControl).interfaceId);
        holderAccessControl = newHolderAccessControl;
        emit HolderAccessControlUpdated(newHolderAccessControl);
    }

    /// @inheritdoc IOrionVault
    function setTransferAccessControl(address newTransferAccessControl) external onlyManager {
        _requireValidAccessControl(newTransferAccessControl, type(IOrionTransferAccessControl).interfaceId);
        transferAccessControl = newTransferAccessControl;
        emit TransferAccessControlUpdated(newTransferAccessControl);
    }

    /// @dev Every ERC-20 balance change is routed through `_update`.
    ///
    ///      Guard:
    ///      - `from != address(0)` excludes mint, e.g. `fulfillDeposit`.
    ///      - `to != address(0)` excludes burn, e.g. `redeem, fulfillRedeem`.
    ///      - `from != address(this)` excludes vault-as-sender, e.g. `cancelRedeemRequest`.
    ///      - `to != address(this)` excludes vault-as-recipient, e.g. `requestRedeem`.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0) && from != address(this) && to != address(this)) {
            if (transferAccessControl != address(0)) {
                if (!IOrionTransferAccessControl(transferAccessControl).canTransferShares(from, msg.data)) {
                    revert ErrorsLib.ShareTransferNotAllowed();
                }
            }
            if (holderAccessControl != address(0)) {
                if (!IOrionHolderAccessControl(holderAccessControl).canHoldShares(to)) {
                    revert ErrorsLib.ShareTransferNotAllowed();
                }
            }
        }
        super._update(from, to, value);
    }

    /// @notice Update the fee model parameters with cooldown protection
    /// @param feeType The fee type
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
    function pendingDepositCount() external view returns (uint256) {
        return _depositRequests.length();
    }

    /// @inheritdoc IOrionVault
    function pendingRedeemCount() external view returns (uint256) {
        return _redeemRequests.length();
    }

    /// @inheritdoc IOrionVault
    function pendingRedeemBatch(uint256 fulfillBatchSize) external view returns (address[] memory, uint256[] memory) {
        uint256 length = _redeemRequests.length();
        if (length == 0) {
            return (new address[](0), new uint256[](0));
        }
        uint256 batchSize = Math.min(length, fulfillBatchSize);
        address[] memory users = new address[](batchSize);
        uint256[] memory shares = new uint256[](batchSize);
        for (uint256 i = 0; i < batchSize; ++i) {
            (users[i], shares[i]) = _redeemRequests.at(i);
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

        // Process requests in batch. Re-check canHoldShares so mid-epoch revoke does not mint;
        // escrow underlying (same claim path as failed redemption) and continue the batch.
        uint256 processedAmount = 0;
        for (uint256 i = 0; i < batchSize; ++i) {
            address user = users[i];
            uint256 amount = amounts[i];

            // slither-disable-next-line unused-return
            _depositRequests.remove(user);

            if (holderAccessControl != address(0)) {
                if (!IOrionHolderAccessControl(holderAccessControl).canHoldShares(user)) {
                    _pendingUnderlyingClaims.byUser[user] += amount;
                    _pendingUnderlyingClaims.total += amount;
                    liquidityOrchestrator.returnDepositFunds(address(this), amount);
                    emit DepositFulfillmentFailed(user, amount);
                    continue;
                }
            }

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
            processedShares += userShares;

            _payoutOrEscrowRedemption(user, underlyingAmount, userShares);
        }
        _burn(address(this), processedShares);
    }

    /// @inheritdoc IOrionVault
    function totalPendingUnderlyingClaims() external view returns (uint256) {
        return _pendingUnderlyingClaims.total;
    }

    /// @inheritdoc IOrionVault
    function claimUnderlying() external nonReentrant {
        uint256 amount = _pendingUnderlyingClaims.byUser[msg.sender];
        if (amount == 0) revert ErrorsLib.InsufficientAmount();

        _pendingUnderlyingClaims.byUser[msg.sender] = 0;
        _pendingUnderlyingClaims.total -= amount;

        IERC20(asset()).safeTransfer(msg.sender, amount);
        emit RedemptionClaimed(msg.sender, amount);
    }

    /// @dev Push underlying to the user; on revert, escrow on this vault for later claim.
    function _payoutOrEscrowRedemption(address user, uint256 underlyingAmount, uint256 userShares) internal {
        try liquidityOrchestrator.transferRedemptionFunds(user, underlyingAmount) {
            emit Redeem(user, underlyingAmount, userShares);
        } catch {
            _pendingUnderlyingClaims.byUser[user] += underlyingAmount;
            _pendingUnderlyingClaims.total += underlyingAmount;
            liquidityOrchestrator.transferRedemptionFunds(address(this), underlyingAmount);
            emit RedemptionFailed(user, underlyingAmount, userShares);
        }
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[46] private __gap;
}
