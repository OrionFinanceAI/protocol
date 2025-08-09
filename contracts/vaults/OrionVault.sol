// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/ILiquidityOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title OrionVault
 * @notice A modular asset management vault powered by curator intents, with asynchronous deposits and withdrawals
 * @dev
 * OrionVault is an abstract base contract that provides common functionality for transparent and encrypted vaults.
 * It implements the asynchronous pattern for deposits and withdrawals as defined in EIP-7540.
 * The vault interprets curator-submitted intents as portfolio allocation targets, expressed as percentages
 * of the total value locked (TVL). These intents define how assets should be allocated or rebalanced over time.
 *
 * Key features:
 * - Asynchronous deposits and withdrawals via request queues
 * - Share price and total assets tracking
 * - Access control for curator and orchestrator roles
 * - ERC4626 vault standard compliance
 * - Reentrancy protection
 *
 * Derived contracts implement the specific intent submission and interpretation logic, either in plaintext
 * (OrionTransparentVault) or encrypted form (OrionEncryptedVault) for privacy-preserving vaults.
 *
 * The vault maintains the following key states that the orchestrators must track and manage:
 *
 * 1. Total Assets (t_0) [assets] - The total value of assets under management in the vault
 *    - Stored in: _totalAssets
 *    - Units: Asset tokens (e.g., USDC, ETH)
 *
 * 2. Deposit Requests (DR_a) [assets] - Pending deposit requests from liquidity providers
 *    - Stored in: _depositRequests mapping
 *    - Units: Asset tokens (e.g., USDC, ETH)
 *    - @dev These are denominated in underlying asset units, not shares
 *
 * 3. Withdraw Requests (WR_s) [shares] - Pending withdrawal requests from liquidity providers
 *    - Stored in: _withdrawRequests mapping
 *    - Units: Vault share tokens
 *    - @dev These are denominated in vault share units, not underlying assets
 *
 * 4. Portfolio Weights (w_0) [shares] - Current portfolio expressed as the number of shares per asset.
 *    - Units: Number of shares
 *    - Using shares instead of percentages allows the estimated TVL to be derived by multiplying with estimated prices.
 *      This reduces reliance on on-chain price adapters and allows the adapter contract to remain stateless.
 *
 * 5. Curator Intent (w_1) [%] - Target portfolio expressed in percentage of total assets.
 *    - Units: Percentage points
 *    - This value must be specified in percentage of total supply because
 *      the curator does not know the point-in-time amount of assets in the vault at the time of intent submission.
 *      While the curator can estimate this value reading the vault's state and adapter prices,
 *      the actual value at time of execution may differ.
 */
abstract contract OrionVault is ERC4626, ReentrancyGuard, IOrionVault {
    using Math for uint256;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.AddressSet;

    IOrionConfig public config;
    address public vaultOwner;
    address public curator;

    /// @notice Vault-specific whitelist of assets for intent validation
    /// @dev This is a subset of the protocol whitelist for higher auditability
    EnumerableSet.AddressSet private _vaultWhitelistedAssets;

    /// @notice Total assets under management (t_0) - denominated in underlying asset units
    uint256 internal _totalAssets;

    /// @notice Deposit requests queue (D) - mapping of user address to requested asset amount
    /// Units: Asset tokens (e.g., USDC, ETH), not shares
    EnumerableMap.AddressToUintMap private _depositRequests;

    /// @notice Withdraw requests queue (W) - mapping of user address to requested share amount
    /// Units: Vault share tokens, not underlying assets
    EnumerableMap.AddressToUintMap private _withdrawRequests;

    /// @notice Cached total pending deposits - updated incrementally for gas efficiency
    /// Units: Asset tokens (e.g., USDC, ETH), not shares
    uint256 private _totalPendingDeposits;

    /// @notice Cached total pending withdrawals - updated incrementally for gas efficiency
    /// Units: Vault share tokens, not underlying assets
    uint256 private _totalPendingWithdrawals;

    /// @notice Share token decimals
    uint8 public constant SHARE_DECIMALS = 18;

    /* -------------------------------------------------------------------------- */
    /*                               CURATOR FEES                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Year in seconds
    uint32 public constant YEAR_IN_SECONDS = 365 days;

    uint16 public constant CURATOR_FEE_FACTOR = 10_000;
    uint16 public constant MAX_MANAGEMENT_FEE = 300; // 3%
    uint16 public constant MAX_PERFORMANCE_FEE = 3_000; // 30%

    /// @notice Calculation mode
    enum CalcMode {
        FLAT,
        HURDLE,
        HWM,
        HURDLE_HWM
    }

    /// @notice Fee model
    /// @dev This struct is used to define the fee model for the vault
    struct FeeModel {
        /// @notice Calculation mode
        CalcMode mode;
        /// @notice Performance fee - charged on the performance of the vault
        uint16 performanceFee;
        /// @notice Management fee - charged on the total assets of the vault
        uint16 managementFee;
        /// @notice High watermark for performance fees
        uint256 highWaterMark;
    }

    /// @notice Fee model
    FeeModel public feeModel;

    /// @dev Restricts function to only vault owner
    modifier onlyVaultOwner() {
        if (msg.sender != vaultOwner) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    /// @dev Restricts function to only vault curator
    modifier onlyCurator() {
        if (msg.sender != curator) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    /// @dev Restricts function to only internal states orchestrator
    modifier onlyInternalStatesOrchestrator() {
        if (msg.sender != config.internalStatesOrchestrator()) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    /// @dev Restricts function to only liquidity orchestrator
    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != config.liquidityOrchestrator()) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    constructor(
        address vaultOwner_,
        address curator_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(IERC20Metadata(address(config_.underlyingAsset()))) {
        if (curator_ == address(0)) revert ErrorsLib.InvalidAddress();
        if (address(config_) == address(0)) revert ErrorsLib.InvalidAddress();

        vaultOwner = vaultOwner_;
        curator = curator_;
        config = config_;
        _totalAssets = 0;
        _totalPendingDeposits = 0;
        _totalPendingWithdrawals = 0;

        uint8 underlyingDecimals = IERC20Metadata(address(config_.underlyingAsset())).decimals();
        if (underlyingDecimals > SHARE_DECIMALS) revert ErrorsLib.InvalidUnderlyingDecimals();

        feeModel = FeeModel({
            mode: CalcMode.FLAT,
            performanceFee: 0,
            managementFee: 0,
            highWaterMark: 10 ** SHARE_DECIMALS
        });

        _initializeVaultWhitelist();
    }

    /// @notice Initialize the vault whitelist with all protocol whitelisted assets
    /// @dev This sets the initial vault whitelist to match the protocol whitelist as a default.
    ///      This can be overridden by the vault owner to set a subset of the protocol whitelist.
    function _initializeVaultWhitelist() internal {
        address[] memory protocolAssets = config.getAllWhitelistedAssets();
        for (uint256 i = 0; i < protocolAssets.length; i++) {
            bool inserted = _vaultWhitelistedAssets.add(protocolAssets[i]);
            if (!inserted) revert ErrorsLib.AlreadyRegistered();
        }
    }

    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function mint(uint256, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function withdraw(uint256, address, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function redeem(uint256, address, address) public pure override(ERC4626, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return _totalAssets;
    }

    /// @notice Override ERC4626 decimals to always use SHARE_DECIMALS regardless of underlying asset decimals
    /// @dev This ensures consistent 18-decimal precision for share tokens across all vaults
    /// @return SHARE_DECIMALS for all vault share tokens
    function decimals() public view virtual override(ERC4626, IERC20Metadata) returns (uint8) {
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

    function convertToShares(uint256 assets) public view override(ERC4626, IERC4626) returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override(ERC4626, IERC4626) returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    /// @inheritdoc IOrionVault
    function convertToAssetsWithPITTotalAssets(
        uint256 shares,
        uint256 pointInTimeTotalAssets,
        Math.Rounding rounding
    ) public view returns (uint256) {
        uint256 supply = totalSupply();
        return shares.mulDiv(pointInTimeTotalAssets + 1, supply + 10 ** _decimalsOffset(), rounding);
    }

    /// --------- LP FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function requestDeposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        uint256 senderBalance = IERC20(asset()).balanceOf(msg.sender);
        if (amount > senderBalance) revert ErrorsLib.InsufficientFunds(msg.sender, senderBalance, amount);

        bool success = IERC20(asset()).transferFrom(msg.sender, config.liquidityOrchestrator(), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // slither-disable-next-line unused-return
        (, uint256 currentAmount) = _depositRequests.tryGet(msg.sender);
        // slither-disable-next-line unused-return
        _depositRequests.set(msg.sender, currentAmount + amount);
        _totalPendingDeposits += amount;

        emit EventsLib.DepositRequested(msg.sender, amount);
    }

    /// @inheritdoc IOrionVault
    function cancelDepositRequest(uint256 amount) external nonReentrant {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        // slither-disable-next-line unused-return
        (, uint256 currentAmount) = _depositRequests.tryGet(msg.sender);
        if (currentAmount < amount) revert ErrorsLib.NotEnoughDepositRequest();

        // Interactions - request funds from liquidity orchestrator
        ILiquidityOrchestrator(config.liquidityOrchestrator()).returnDepositFunds(msg.sender, amount);

        // Effects - update internal state
        uint256 newAmount = currentAmount - amount;
        if (newAmount == 0) {
            // slither-disable-next-line unused-return
            _depositRequests.remove(msg.sender);
        } else {
            // slither-disable-next-line unused-return
            _depositRequests.set(msg.sender, newAmount);
        }
        _totalPendingDeposits -= amount;

        emit EventsLib.DepositRequestCancelled(msg.sender, amount);
    }

    /// @inheritdoc IOrionVault
    function requestWithdraw(uint256 shares) external {
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        uint256 senderBalance = balanceOf(msg.sender);
        if (shares > senderBalance) revert ErrorsLib.InsufficientFunds(msg.sender, senderBalance, shares);

        bool success = IERC20(address(this)).transferFrom(msg.sender, config.liquidityOrchestrator(), shares);
        if (!success) revert ErrorsLib.TransferFailed();

        // slither-disable-next-line unused-return
        (, uint256 currentShares) = _withdrawRequests.tryGet(msg.sender);
        // slither-disable-next-line unused-return
        _withdrawRequests.set(msg.sender, currentShares + shares);
        _totalPendingWithdrawals += shares;

        emit EventsLib.WithdrawRequested(msg.sender, shares);
    }

    /// @inheritdoc IOrionVault
    function cancelWithdrawRequest(uint256 shares) external nonReentrant {
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        // slither-disable-next-line unused-return
        (, uint256 currentShares) = _withdrawRequests.tryGet(msg.sender);
        if (currentShares < shares) revert ErrorsLib.NotEnoughWithdrawRequest();

        // Interactions - request share tokens from liquidity orchestrator
        ILiquidityOrchestrator(config.liquidityOrchestrator()).returnWithdrawShares(msg.sender, shares);

        // Effects - update internal state
        uint256 newShares = currentShares - shares;
        if (newShares == 0) {
            // slither-disable-next-line unused-return
            _withdrawRequests.remove(msg.sender);
        } else {
            // slither-disable-next-line unused-return
            _withdrawRequests.set(msg.sender, newShares);
        }
        _totalPendingWithdrawals -= shares;

        emit EventsLib.WithdrawRequestCancelled(msg.sender, shares);
    }

    /// --------- VAULT OWNER AND CURATOR FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function updateCurator(address newCurator) external onlyVaultOwner {
        if (newCurator == address(0)) revert ErrorsLib.InvalidAddress();
        curator = newCurator;
    }

    /// @inheritdoc IOrionVault
    function updateVaultWhitelist(address[] memory assets) external onlyVaultOwner {
        _vaultWhitelistedAssets.clear();
        for (uint256 i = 0; i < assets.length; i++) {
            address token = assets[i];

            // Protocol whitelist validation
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);

            bool inserted = _vaultWhitelistedAssets.add(token);
            if (!inserted) revert ErrorsLib.AlreadyRegistered();
        }
    }

    /// @notice Update the fee model parameters
    /// @param mode The calculation mode for fees (0=FLAT, 1=HURDLE, 2=HWM, 3=HURDLE_HWM)
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @dev Only vault owner can update fee model parameters
    ///      Performance and management fees are capped by protocol limits
    function updateFeeModel(uint8 mode, uint16 performanceFee, uint16 managementFee) external onlyVaultOwner {
        // Validate mode is within enum range
        if (mode > uint8(CalcMode.HURDLE_HWM)) revert ErrorsLib.InvalidArguments();

        // Validate fee limits against protocol maximums
        if (performanceFee > MAX_PERFORMANCE_FEE) revert ErrorsLib.InvalidArguments();
        if (managementFee > MAX_MANAGEMENT_FEE) revert ErrorsLib.InvalidArguments();

        feeModel.mode = CalcMode(mode);
        feeModel.performanceFee = performanceFee;
        feeModel.managementFee = managementFee;

        emit EventsLib.FeeModelUpdated(mode, performanceFee, managementFee);
    }

    /// @notice Validate that all assets in an intent are whitelisted for this vault
    /// @param assets Array of asset addresses to validate
    /// @dev This function is used by derived contracts to validate curator intents
    function _validateIntentAssets(address[] memory assets) internal view {
        for (uint256 i = 0; i < assets.length; i++) {
            if (!_vaultWhitelistedAssets.contains(assets[i])) {
                revert ErrorsLib.TokenNotWhitelisted(assets[i]);
            }
        }
    }

    /// @inheritdoc IOrionVault
    function curatorFee(uint256 activeTotalAssets) external view returns (uint256) {
        uint256 performanceFeeAmount = _performanceFeeAmount(activeTotalAssets);
        uint256 managementFeeAmount = _managementFeeAmount(activeTotalAssets);
        return performanceFeeAmount + managementFeeAmount;
    }

    /// @notice Calculate performance fee based on the fee model calculation mode
    /// @dev Performance fee calculation depends on the CalcMode
    /// @return The performance fee in underlying asset units
    function _performanceFeeAmount(uint256 activeTotalAssets) internal view returns (uint256) {
        if (feeModel.performanceFee == 0) return 0;

        if (feeModel.mode == CalcMode.FLAT) {
            return _calculateFlatFeeAmount(activeTotalAssets);
        }

        // TODO: _getCurrentSharePrice to follow same logic as _convertToAssets
        // wrapping convertToAssetsWithPITTotalAssets, here using the inner function
        // accepting input, hurdle rate update below,
        // if performed after other states updates, can use the wrapper function with vault totalassets.
        uint256 currentSharePrice = _getCurrentSharePrice();

        if (feeModel.mode == CalcMode.HWM) {
            return _calculateHWMFeeAmount(currentSharePrice);
        } else if (feeModel.mode == CalcMode.HURDLE) {
            return _calculateHurdleFeeAmount(currentSharePrice);
        } else if (feeModel.mode == CalcMode.HURDLE_HWM) {
            return _calculateHurdleHWMFeeAmount(currentSharePrice);
        }
    }

    /// @notice Calculate flat performance fee
    function _calculateFlatFeeAmount(uint256 activeTotalAssets) internal view returns (uint256) {
        return (uint256(feeModel.performanceFee) * activeTotalAssets) / CURATOR_FEE_FACTOR;
    }

    /// @notice Calculate high watermark performance fee
    function _calculateHWMFeeAmount(uint256 currentSharePrice) internal view returns (uint256) {
        if (currentSharePrice <= feeModel.highWaterMark) return 0;
        return _calculateExcessFee(currentSharePrice - feeModel.highWaterMark);
    }

    /// @notice Calculate hurdle rate performance fee
    function _calculateHurdleFeeAmount(uint256 currentSharePrice) internal view returns (uint256) {
        // TODO: verify correct number of decimals.
        uint256 hurdlePrice = _getHurdlePrice();
        if (currentSharePrice <= hurdlePrice) return 0;
        return _calculateExcessFee(currentSharePrice - hurdlePrice);
    }

    /// @notice Calculate combined hurdle and high watermark performance fee
    function _calculateHurdleHWMFeeAmount(uint256 currentSharePrice) internal view returns (uint256) {
        uint256 hurdlePrice = _getHurdlePrice();
        uint256 threshold = hurdlePrice > feeModel.highWaterMark ? hurdlePrice : feeModel.highWaterMark;
        if (currentSharePrice <= threshold) return 0;
        return _calculateExcessFee(currentSharePrice - threshold);
    }

    /// @notice Calculate fee on excess performance
    function _calculateExcessFee(uint256 excessPerformance) internal view returns (uint256) {
        // TODO: verify correct number of decimals.
        uint256 supply = totalSupply();
        if (supply == 0) return 0;

        // TODO: verify correct number of decimals
        uint256 excessValue = excessPerformance.mulDiv(supply, 10 ** this.decimals());
        // TODO: verify correct number of decimals
        return uint256(feeModel.performanceFee).mulDiv(excessValue, CURATOR_FEE_FACTOR);
    }

    /// @notice Get hurdle price based on risk-free rate
    function _getHurdlePrice() internal view returns (uint256) {
        uint256 riskFreeRate = config.riskFreeRate();
        // TODO: use updateInterval from orchestrator? Calling it in other moments would make it wrong. ok?
        uint256 timeElapsed = 0;
        // TODO: verify correct number of decimals.
        uint256 hurdleReturn = (riskFreeRate * feeModel.highWaterMark * timeElapsed) /
            (CURATOR_FEE_FACTOR * YEAR_IN_SECONDS);
        return feeModel.highWaterMark + hurdleReturn;
    }

    /// @notice Get current share price
    /// @dev Calculates the current share price as totalAssets / totalSupply
    /// @return Current share price
    function _getCurrentSharePrice() internal view returns (uint256) {
        // TODO: accept total assets as input.
        // TODO: verify correct number of decimals.
        uint256 supply = totalSupply();
        if (supply == 0) return 10 ** this.decimals(); // Initial price of 1.0

        // TODO: verify correct number of decimals.
        return (_totalAssets * (10 ** this.decimals())) / supply;
    }

    /// @notice Calculate management fee
    /// @return The management fee in underlying asset units
    function _managementFeeAmount(uint256 activeTotalAssets) internal view returns (uint256) {
        if (feeModel.managementFee == 0) return 0;

        uint256 timeElapsed = 0; // TODO: use updateInterval from orchestrator, ok default to this? Discuss.
        if (timeElapsed == 0) return 0;

        // TODO: verify correct number of decimals.
        uint256 annualFeeRate = uint256(feeModel.managementFee).mulDiv(activeTotalAssets, CURATOR_FEE_FACTOR);
        // TODO: verify correct number of decimals.
        return annualFeeRate.mulDiv(timeElapsed, YEAR_IN_SECONDS);
    }

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function getPendingDeposits() external view returns (uint256) {
        return _totalPendingDeposits;
    }

    /// @inheritdoc IOrionVault
    function getPendingWithdrawals() external view returns (uint256) {
        return _totalPendingWithdrawals;
    }

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function processDepositRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint32 length = uint32(_depositRequests.length());
        // Collect all requests first to avoid index shifting issues when removing during iteration
        address[] memory users = new address[](length);
        uint256[] memory amounts = new uint256[](length);

        for (uint32 i = 0; i < length; i++) {
            (address user, uint256 amount) = _depositRequests.at(i);
            users[i] = user;
            amounts[i] = amount;
        }

        // Process all requests
        for (uint32 i = 0; i < length; i++) {
            address user = users[i];
            uint256 amount = amounts[i];
            uint256 shares = previewDeposit(amount);

            // slither-disable-next-line unused-return
            _depositRequests.remove(user);

            _mint(user, shares);

            emit EventsLib.DepositProcessed(user, amount);
        }

        // Reset the cached total since all requests were processed
        _totalPendingDeposits = 0;
    }

    /// @inheritdoc IOrionVault
    function processWithdrawRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint32 length = uint32(_withdrawRequests.length());
        // Collect all requests first to avoid index shifting issues when removing during iteration
        address[] memory users = new address[](length);
        uint256[] memory sharesArray = new uint256[](length);

        for (uint32 i = 0; i < length; i++) {
            (address user, uint256 shares) = _withdrawRequests.at(i);
            users[i] = user;
            sharesArray[i] = shares;
        }

        // Reset the cached total since all requests will be processed
        _totalPendingWithdrawals = 0;

        // Process all requests
        for (uint32 i = 0; i < length; i++) {
            address user = users[i];
            uint256 shares = sharesArray[i];

            // slither-disable-next-line unused-return
            _withdrawRequests.remove(user);

            _burn(address(this), shares);
            uint256 underlyingAmount = previewRedeem(shares);
            if (!IERC20(asset()).transfer(user, underlyingAmount)) revert ErrorsLib.TransferFailed();

            // TODO: Not sure about processWithdrawRequests logic,
            // I am not transferring LP share tokens back to the vault and
            // I am not taking USDC from the liquidity orchestrator. Please fix.

            emit EventsLib.WithdrawProcessed(user, shares);
        }
    }

    /// @notice Update the high watermark after trades are executed
    /// @dev Should be called by the liquidity orchestrator after portfolio rebalancing
    ///      Updates high watermark if current share price exceeds the previous high watermark
    function updateHighWaterMark() external onlyLiquidityOrchestrator {
        // TODO: If vault states updated, ok to use real total assets/share price here.
        // Wrapper needed, keep a to do in orchestrator, this update needs to be done after all other states updates.
        uint256 currentSharePrice = _getCurrentSharePrice();

        // Update high watermark if current price is higher
        if (currentSharePrice > feeModel.highWaterMark) {
            feeModel.highWaterMark = currentSharePrice;
        }
    }
}
