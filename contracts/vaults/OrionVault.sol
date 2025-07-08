// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
 *    - Note: These are denominated in underlying asset units, not shares
 *
 * 3. Withdraw Requests (WR_s) [shares] - Pending withdrawal requests from liquidity providers
 *    - Stored in: _withdrawRequests mapping
 *    - Units: Vault share tokens
 *    - Note: These are denominated in vault share units, not underlying assets
 *
 * 4. Portfolio Weights (w_0) [shares] - Current portfolio expressed as the number of shares per asset.
 *    - Units: Number of shares
 *    - Using shares instead of percentages allows the estimated TVL to be derived by multiplying with estimated prices.
 *      This reduces reliance on on-chain price oracles and allows the oracle contract to remain stateless.
 *
 * 5. Curator Intent (w_1) [%] - Target portfolio expressed in percentage of total assets.
 *    - Units: Percentage points
 *    - This value must be specified in percentage of total supply because
 *      the curator does not know the point-in-time amount of assets in the vault at the time of intent submission.
 *      While the curator can estimate this value reading the vault’s state and oracle prices,
 *      the actual value at time of execution may differ.
 */
abstract contract OrionVault is
    Initializable,
    ERC4626Upgradeable,
    ReentrancyGuardUpgradeable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IOrionVault
{
    using Math for uint256;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    IOrionConfig public config;
    address public curator;
    address public deployer;

    /// @notice Total assets under management (t_0) - denominated in underlying asset units
    uint256 internal _totalAssets;

    /// @notice Deposit requests queue (D) - mapping of user address to requested asset amount
    /// Units: Asset tokens (e.g., USDC, ETH), not shares
    mapping(address => uint256) private _depositRequests;

    /// @notice Withdraw requests queue (W) - mapping of user address to requested share amount
    /// Units: Vault share tokens, not underlying assets
    mapping(address => uint256) private _withdrawRequests;

    /// @notice Array of users who have pending deposit requests
    address[] private _depositRequestors;

    /// @notice Array of users who have pending withdrawal requests
    address[] private _withdrawRequestors;

    modifier onlyCurator() {
        if (msg.sender != curator) revert ErrorsLib.NotCurator();
        _;
    }

    modifier onlyInternalStatesOrchestrator() {
        if (msg.sender != config.internalStatesOrchestrator()) revert ErrorsLib.NotInternalStatesOrchestrator();
        _;
    }

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != config.liquidityOrchestrator()) revert ErrorsLib.NotLiquidityOrchestrator();
        _;
    }

    // slither-disable-next-line naming-convention
    // solhint-disable-next-line func-name-mixedcase
    function __OrionVault_init(
        address curator_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_
    ) internal onlyInitializing {
        if (curator_ == address(0)) revert ErrorsLib.InvalidCuratorAddress();
        if (address(config_) == address(0)) revert ErrorsLib.InvalidConfigAddress();

        __ERC20_init(name_, symbol_);
        __ERC4626_init(config_.underlyingAsset());
        __ReentrancyGuard_init();

        __Ownable_init(curator_);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        deployer = msg.sender;
        curator = curator_;
        config = config_;
        _totalAssets = 0;
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyCurator {
        // Only the curator can upgrade the contract
    }

    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function mint(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function withdraw(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function redeem(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousCallDisabled();
    }

    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _totalAssets;
    }

    /* ---------- CONVERSION FUNCTIONS ---------- */

    function convertToShares(uint256 assets) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    // Defends with a "virtual offset"‑free formula recommended by OZ
    // https://docs.openzeppelin.com/contracts/5.x/erc4626#defending_with_a_virtual_offset
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return convertToAssetsWithPITTotalAssets(shares, _totalAssets, rounding);
    }

    function convertToAssetsWithPITTotalAssets(
        uint256 shares,
        uint256 pointInTimeTotalAssets,
        Math.Rounding rounding
    ) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint8 statesDecimals = config.statesDecimals();
        return shares.mulDiv(pointInTimeTotalAssets + 1, supply + 10 ** statesDecimals, rounding);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 supply = totalSupply();
        uint8 statesDecimals = config.statesDecimals();
        return assets.mulDiv(supply + 10 ** statesDecimals, _totalAssets + 1, rounding);
    }

    /// --------- LP FUNCTIONS ---------

    /// @notice Submit an asynchronous deposit request.
    /// @dev No share tokens are minted immediately. The specified amount of underlying tokens
    ///      is transferred to the liquidity orchestrator for centralized liquidity management.
    ///      LPs can later cancel this request to withdraw their funds before any minting occurs.
    /// @param amount The amount of the underlying asset to deposit.
    function requestDeposit(uint256 amount) external nonReentrant {
        // Checks first
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        if (_depositRequests[msg.sender] == 0) {
            _depositRequestors.push(msg.sender);
        }

        // Effects - update internal state before external interactions
        _depositRequests[msg.sender] += amount;

        // Interactions - transfer funds directly to liquidity orchestrator
        bool success = IERC20(asset()).transferFrom(msg.sender, config.liquidityOrchestrator(), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        emit EventsLib.DepositRequested(msg.sender, amount);
    }

    /// @notice Cancel a previously submitted deposit request.
    /// @dev Allows LPs to withdraw their funds before any share tokens are minted.
    ///      The request must still have enough balance remaining to cover the cancellation.
    ///      Funds are returned from the liquidity orchestrator.
    /// @param amount The amount of funds to withdraw.
    function cancelDepositRequest(uint256 amount) external nonReentrant {
        // Checks first
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());
        if (_depositRequests[msg.sender] < amount) revert ErrorsLib.NotEnoughDepositRequest();

        // Effects - update internal state before external interactions
        _depositRequests[msg.sender] -= amount;

        // Interactions - request funds from liquidity orchestrator
        ILiquidityOrchestrator(config.liquidityOrchestrator()).returnDepositFunds(msg.sender, amount);

        emit EventsLib.DepositRequestCancelled(msg.sender, amount);
    }

    /// @notice LPs submits async withdrawal request; shares locked until processed
    function requestWithdraw(uint256 shares) external {
        // Checks first
        if (shares == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();
        if (balanceOf(msg.sender) < shares) revert ErrorsLib.NotEnoughShares();

        // Effects - update internal state before transfers
        if (_withdrawRequests[msg.sender] == 0) {
            _withdrawRequestors.push(msg.sender);
        }
        _withdrawRequests[msg.sender] += shares;

        // Interactions - lock shares by transferring them to contract as escrow
        _transfer(msg.sender, address(this), shares);

        emit EventsLib.WithdrawRequested(msg.sender, shares);
    }

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @notice Get total pending deposit amount across all users
    /// @return Total pending deposits denominated in underlying asset units (e.g., USDC, ETH)
    /// Note: This returns asset amounts, not share amounts
    function getPendingDeposits() external view returns (uint256) {
        uint256 totalPending = 0;
        uint256 length = _depositRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            totalPending += _depositRequests[_depositRequestors[i]];
        }
        return totalPending;
    }

    /// @notice Get total pending withdrawal shares across all users
    /// @return Total pending withdrawals denominated in vault share units
    /// Note: This returns share amounts, not underlying asset amounts
    function getPendingWithdrawals() external view returns (uint256) {
        uint256 totalPending = 0;
        uint256 length = _withdrawRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            totalPending += _withdrawRequests[_withdrawRequestors[i]];
        }
        return totalPending;
    }

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process deposit requests from LPs and reset the requestor's request amount
    function processDepositRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 length = _depositRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            address user = _depositRequestors[i];
            uint256 amount = _depositRequests[user];
            uint256 shares = previewDeposit(amount);

            _depositRequests[user] = 0;

            _mint(user, shares);

            emit EventsLib.DepositProcessed(user, amount);
        }
    }

    /// @notice Process withdrawal requests from LPs
    function processWithdrawRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 length = _withdrawRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            address user = _withdrawRequestors[i];
            uint256 shares = _withdrawRequests[user];

            _withdrawRequests[user] = 0;

            _burn(address(this), shares);
            uint256 underlyingAmount = previewRedeem(shares);
            if (!IERC20(asset()).transfer(user, underlyingAmount)) revert ErrorsLib.TransferFailed();

            emit EventsLib.WithdrawProcessed(user, shares);
        }
    }

    // TODO: add function for liquidity orchestrator to update portfolio weights.

    // TODO: add function for liquidity orchestrator to deposit assets in curator fee escrow?
    // And therefore another for curator to withdraw assets from curator fee escrow?
    // Or pay curator fee directly from liquidity orchestrator?

    /// --------- ABSTRACT FUNCTIONS ---------
    /// @notice Derived contracts implement their specific submitIntent functions
}
