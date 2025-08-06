// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
abstract contract OrionVault is ERC4626, ReentrancyGuard, Ownable, IOrionVault {
    using Math for uint256;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    IOrionConfig public config;
    address public curator;
    address public deployer;

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

    /// @notice Factor to convert between underlying and share decimals
    uint256 private _deltaFactor;

    modifier onlyCurator() {
        if (msg.sender != curator) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    modifier onlyInternalStatesOrchestrator() {
        if (msg.sender != config.internalStatesOrchestrator()) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != config.liquidityOrchestrator()) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    constructor(
        address curator_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(IERC20Metadata(address(config_.underlyingAsset()))) Ownable(curator_) {
        if (curator_ == address(0)) revert ErrorsLib.InvalidAddress();
        if (address(config_) == address(0)) revert ErrorsLib.InvalidAddress();

        deployer = msg.sender;
        curator = curator_;
        config = config_;
        _totalAssets = 0;
        _totalPendingDeposits = 0;
        _totalPendingWithdrawals = 0;

        /// TODO: underlyingDecimals computed both here and in InternalStatesOrchestrator.sol, avoid code duplication,
        // compute it when setting underlying asset in the config contract.

        uint8 underlyingDecimals = IERC20Metadata(address(config_.underlyingAsset())).decimals();
        if (underlyingDecimals > 18) revert ErrorsLib.InvalidUnderlyingDecimals();
        uint8 deltaDecimals = uint8(18 - underlyingDecimals);
        _deltaFactor = 10 ** deltaDecimals;
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

    /* ---------- CONVERSION FUNCTIONS ---------- */

    function convertToShares(uint256 assets) public view override(ERC4626, IERC4626) returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override(ERC4626, IERC4626) returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    // Defends with a "virtual offset"‑free formula recommended by OZ
    // https://docs.openzeppelin.com/contracts/5.x/erc4626#defending_with_a_virtual_offset
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return convertToAssetsWithPITTotalAssets(shares, _totalAssets, rounding);
    }

    /// @inheritdoc IOrionVault
    function convertToAssetsWithPITTotalAssets(
        uint256 shares,
        uint256 pointInTimeTotalAssets,
        Math.Rounding rounding
    ) public view returns (uint256) {
        uint256 supply = totalSupply();
        return shares.mulDiv(pointInTimeTotalAssets + 1, supply + _deltaFactor, rounding);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 supply = totalSupply();
        return assets.mulDiv(supply + _deltaFactor, _totalAssets + 1, rounding);
    }

    /// --------- LP FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function requestDeposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

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
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

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
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

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
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

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

    /// --------- CURATOR FUNCTIONS ---------

    // TODO: Curator to add vault-specific whitelist (as long as subset of protocol whitelist) for higher auditability.
    // Defaulting to protocol whitelist (so when protocol whitelist updated, vault whitelist is updated as well).

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
        uint256 length = _depositRequests.length();
        // Collect all requests first to avoid index shifting issues when removing during iteration
        address[] memory users = new address[](length);
        uint256[] memory amounts = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            (address user, uint256 amount) = _depositRequests.at(i);
            users[i] = user;
            amounts[i] = amount;
        }

        // Process all requests
        for (uint256 i = 0; i < length; i++) {
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
        uint256 length = _withdrawRequests.length();
        // Collect all requests first to avoid index shifting issues when removing during iteration
        address[] memory users = new address[](length);
        uint256[] memory sharesArray = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            (address user, uint256 shares) = _withdrawRequests.at(i);
            users[i] = user;
            sharesArray[i] = shares;
        }

        // Reset the cached total since all requests will be processed
        _totalPendingWithdrawals = 0;

        // Process all requests
        for (uint256 i = 0; i < length; i++) {
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
}
