// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";
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

    uint256 public sharePrice;
    uint256 internal _totalAssets;

    // Queues of async requests from LPs
    mapping(address => uint256) private _depositRequests;
    mapping(address => uint256) private _withdrawRequests;

    address[] private _depositRequestors;
    address[] private _withdrawRequestors;

    // Portfolio state managed by orchestrators
    EnumerableMap.AddressToUintMap private _portfolio;

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

        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(curator_);

        deployer = msg.sender;
        curator = curator_;
        config = config_;
        sharePrice = 10 ** config.statesDecimals();
        _totalAssets = 0;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyCurator {}

    /// --------- PUBLIC FUNCTIONS ---------
    /// @notice Disable direct deposits and withdrawals on ERC4626 to enforce async only
    function deposit(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousDepositsDisabled();
    }

    function mint(uint256, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousDepositsDisabled();
    }

    function withdraw(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousWithdrawalsDisabled();
    }

    function redeem(uint256, address, address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        revert ErrorsLib.SynchronousRedemptionsDisabled();
    }

    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view override(ERC4626Upgradeable, IERC4626) returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    /* ---------- INTERNAL ---------- */

    // Defends with a “virtual offset”‑free formula recommended by OZ
    // https://docs.openzeppelin.com/contracts/5.x/erc4626#defending_with_a_virtual_offset
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 supply = totalSupply();
        uint8 statesDecimals = config.statesDecimals();
        return shares.mulDiv(_totalAssets + 1, supply + 10 ** statesDecimals, rounding);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 supply = totalSupply();
        uint8 statesDecimals = config.statesDecimals();
        return assets.mulDiv(supply + 10 ** statesDecimals, _totalAssets + 1, rounding);
    }

    /// --------- LP FUNCTIONS ---------

    /// @notice LPs submits async deposit request; no share tokens minted yet,
    /// while underlying tokens are transferred to the vault contract as escrow.
    function requestDeposit(uint256 amount) external nonReentrant {
        // Checks first
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());

        if (_depositRequests[msg.sender] == 0) {
            _depositRequestors.push(msg.sender);
        }

        // Effects - update internal state before external interactions
        _depositRequests[msg.sender] += amount;

        // Interactions - external calls last
        bool success = IERC20(asset()).transferFrom(msg.sender, address(this), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        emit EventsLib.DepositRequested(msg.sender, amount, _depositRequestors.length);
    }

    /// @notice Allow LPs to cancel their deposit request, withdrawing their escrowed tokens before minting,
    /// this makes the system more trustless.
    /// @param amount The amount of underlying tokens to withdraw from escrow
    function cancelDepositRequest(uint256 amount) external nonReentrant {
        // Checks first
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset());
        if (_depositRequests[msg.sender] < amount) revert ErrorsLib.NotEnoughDepositRequest();

        // Effects - update internal state before external interactions
        _depositRequests[msg.sender] -= amount;
        uint256 depositorCount = _depositRequestors.length;

        // Interactions - external calls last
        bool success = IERC20(asset()).transfer(msg.sender, amount);
        if (!success) revert ErrorsLib.TransferFailed();

        emit EventsLib.DepositRequestCancelled(msg.sender, amount, depositorCount);
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

        emit EventsLib.WithdrawRequested(msg.sender, shares, _withdrawRequestors.length);
    }

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @notice Update vault state based on market performance and pending operations
    /// @param newSharePrice The new share price after P&L calculation
    /// @param newTotalAssets The new total assets after processing deposits/withdrawals
    function updateVaultState(uint256 newSharePrice, uint256 newTotalAssets) external onlyInternalStatesOrchestrator {
        if (newSharePrice == 0) revert ErrorsLib.ZeroPrice();

        // Update state variables
        sharePrice = newSharePrice;
        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newSharePrice, newTotalAssets);
    }

    /// @notice Get total pending deposit amount across all users
    function getPendingDeposits() external view returns (uint256) {
        uint256 totalPending = 0;
        uint256 length = _depositRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            totalPending += _depositRequests[_depositRequestors[i]];
        }
        return totalPending;
    }

    /// @notice Get total pending withdrawal shares across all users
    function getPendingWithdrawals() external view returns (uint256) {
        uint256 totalPending = 0;
        uint256 length = _withdrawRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            totalPending += _withdrawRequests[_withdrawRequestors[i]];
        }
        return totalPending;
    }

    // TODO: add function to get portfolio weights from internal states orchestrator.

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process deposit requests from LPs and reset the requestor's request amount
    // TODO: consider risks of using internal states to update share price and total assets and then reset them
    // after successful transaction processed
    // In a second step by the liquidity orchestrator. There are risks in this, need to identify an alternative
    // solution.
    // Solution seems to be processing share price update only based on portfolio weights and PNL and then use that
    // to perform the deposit/withdrawals from liquidity orchestrator, updating internal ledger + total assets.
    function processDepositRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 length = _depositRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            address user = _depositRequestors[i];
            uint256 amount = _depositRequests[user];
            uint256 shares = previewDeposit(amount);

            _depositRequests[user] = 0;

            _mint(user, shares);

            emit EventsLib.DepositProcessed(user, amount, i);
        }
    }

    /// @notice Process withdrawal requests from LPs
    // TODO: same as processDepositRequests. Fix.
    function processWithdrawRequests() external onlyLiquidityOrchestrator nonReentrant {
        uint256 length = _withdrawRequestors.length;
        for (uint256 i = 0; i < length; i++) {
            address user = _withdrawRequestors[i];
            uint256 shares = _withdrawRequests[user];

            _withdrawRequests[user] = 0;

            _burn(address(this), shares);
            uint256 underlyingAmount = previewRedeem(shares);
            // slither-disable-next-line calls-loop
            if (!IERC20(asset()).transfer(user, underlyingAmount)) revert ErrorsLib.TransferFailed();

            emit EventsLib.WithdrawProcessed(user, shares, i);
        }
    }

    // TODO: add function for liquidity orchestrator to update portfolio weights.

    /// --------- ABSTRACT FUNCTIONS ---------
    /// @notice Derived contracts implement their specific submitOrderIntent functions
}
