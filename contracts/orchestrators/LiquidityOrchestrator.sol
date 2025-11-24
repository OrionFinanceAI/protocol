// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/ILiquidityOrchestrator.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IInternalStateOrchestrator.sol";
import "../libraries/EventsLib.sol";
import "../interfaces/IOrionTransparentVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/IExecutionAdapter.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
/**
 * @title Liquidity Orchestrator
 * @notice Contract that orchestrates liquidity operations
 * @author Orion Finance
 * @dev This contract is responsible for:
 *      - Executing actual buy and sell orders on investment universe;
 *      - Processing withdrawal requests from LPs;
 *      - Handling slippage and market execution differences from adapter price estimates via liquidity buffer.
 */
contract LiquidityOrchestrator is Ownable2Step, ReentrancyGuard, Pausable, ILiquidityOrchestrator {
    using Math for uint256;
    using SafeERC20 for IERC20;

    /* -------------------------------------------------------------------------- */
    /*                                 CONTRACTS                                  */
    /* -------------------------------------------------------------------------- */
    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Internal States Orchestrator contract address
    IInternalStateOrchestrator public internalStatesOrchestrator;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice Admin address from config
    address public admin;

    /// @notice Execution adapters mapping for assets
    mapping(address => IExecutionAdapter) public executionAdapterOf;

    /* -------------------------------------------------------------------------- */
    /*                               UPKEEP STATE                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Minibatch size for fulfill deposit and redeem processing
    uint8 public minibatchSize;

    /// @notice Upkeep phase
    LiquidityUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice Target buffer ratio (in basis points, where 10000 = 100%)
    uint256 public targetBufferRatio;

    /// @notice Slippage tolerance (in basis points, where 10000 = 100%)
    /// @dev This is set to 50% of targetBufferRatio to ensure all trades pass in worst-case scenarios
    uint256 public slippageTolerance;

    /// @notice Maximum minibatch size
    uint8 public constant MAX_MINIBATCH_SIZE = 8;

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */

    /// @notice Delta buffer amount for current epoch
    int256 public deltaBufferAmount;

    /* -------------------------------------------------------------------------- */
    /*                                MODIFIERS                                   */
    /* -------------------------------------------------------------------------- */

    /// @dev Restricts function to only owner or Chainlink Automation Registry
    modifier onlyAuthorizedTrigger() {
        if (msg.sender != owner() && msg.sender != automationRegistry) {
            revert ErrorsLib.NotAuthorized();
        }
        _;
    }
    /// @dev Restricts function to only Orion Config contract
    modifier onlyConfig() {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only admin from config
    modifier onlyAdmin() {
        if (msg.sender != admin) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only Internal States Orchestrator contract
    modifier onlyInternalStatesOrchestrator() {
        if (msg.sender != address(internalStatesOrchestrator)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor
    /// @param initialOwner The address of the initial owner
    /// @param config_ The address of the OrionConfig contract
    /// @param automationRegistry_ The address of the Chainlink Automation Registry
    constructor(address initialOwner, address config_, address automationRegistry_) Ownable(initialOwner) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(config_);
        underlyingAsset = address(config.underlyingAsset());
        admin = config.admin();

        automationRegistry = automationRegistry_;
        currentPhase = LiquidityUpkeepPhase.Idle;
        minibatchSize = 1;
        slippageTolerance = 0; // Will be set when targetBufferRatio is configured
    }

    /* -------------------------------------------------------------------------- */
    /*                                OWNER FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function updateMinibatchSize(uint8 _minibatchSize) external onlyOwner {
        if (_minibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (_minibatchSize > MAX_MINIBATCH_SIZE) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        minibatchSize = _minibatchSize;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateAutomationRegistry(address newAutomationRegistry) external onlyOwner {
        if (newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        automationRegistry = newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(newAutomationRegistry);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function setInternalStatesOrchestrator(address _internalStatesOrchestrator) external onlyOwner {
        if (_internalStatesOrchestrator == address(0)) revert ErrorsLib.ZeroAddress();
        if (address(internalStatesOrchestrator) != address(0)) revert ErrorsLib.AlreadyRegistered();
        internalStatesOrchestrator = IInternalStateOrchestrator(_internalStatesOrchestrator);
    }

    /// @inheritdoc ILiquidityOrchestrator
    /// @dev Slippage tolerance is set to 50% of targetBufferRatio to support worst-case scenario prices
    ///      and full NAV rebalancing. This ensures ALL trades pass even with maximum price impact.
    function setTargetBufferRatio(uint256 _targetBufferRatio) external onlyOwner {
        if (_targetBufferRatio == 0) revert ErrorsLib.InvalidArguments();
        // 5%
        if (_targetBufferRatio > 500) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        targetBufferRatio = _targetBufferRatio;

        // Set slippage tolerance to 50% of target buffer ratio
        // This is needed to support worst-case scenario prices + full NAV rebalancing
        slippageTolerance = _targetBufferRatio / 2;

        // Update slippage tolerance on all execution adapters
        _updateAllExecutionAdaptersSlippage();
    }

    /// @notice Updates slippage tolerance on all registered execution adapters
    /// @dev Internal function called when slippage tolerance changes
    function _updateAllExecutionAdaptersSlippage() internal {
        address[] memory assets = config.getAllWhitelistedAssets();
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            IExecutionAdapter adapter = executionAdapterOf[asset];
            if (address(adapter) != address(0)) {
                // Call setSlippageTolerance on the adapter (will be defined in interface)
                try adapter.setSlippageTolerance(slippageTolerance) {} catch {
                    // Silently continue if adapter doesn't support slippage tolerance yet
                }
            }
        }
    }

    /// @inheritdoc ILiquidityOrchestrator
    function depositLiquidity(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (internalStatesOrchestrator.currentPhase() != IInternalStateOrchestrator.InternalUpkeepPhase.Idle)
            revert ErrorsLib.SystemNotIdle();

        // Transfer underlying assets from the admin to this contract
        IERC20(underlyingAsset).safeTransferFrom(msg.sender, address(this), amount);

        // Update buffer amount in the internal states orchestrator
        internalStatesOrchestrator.updateBufferAmount(int256(amount));
    }

    /// @inheritdoc ILiquidityOrchestrator
    function withdrawLiquidity(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (internalStatesOrchestrator.currentPhase() != IInternalStateOrchestrator.InternalUpkeepPhase.Idle)
            revert ErrorsLib.SystemNotIdle();

        // Get current buffer amount from internal states orchestrator
        uint256 currentBufferAmount = internalStatesOrchestrator.bufferAmount();

        // Safety check: ensure withdrawal doesn't make buffer negative
        if (amount > currentBufferAmount) revert ErrorsLib.InsufficientAmount();

        // Update buffer amount in the internal states orchestrator
        internalStatesOrchestrator.updateBufferAmount(-int256(amount));

        // Transfer underlying assets to the owner
        IERC20(underlyingAsset).safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function claimProtocolFees(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        internalStatesOrchestrator.subtractPendingProtocolFees(amount);

        IERC20(underlyingAsset).safeTransfer(msg.sender, amount);
    }

    /* -------------------------------------------------------------------------- */
    /*                                CONFIG FUNCTIONS                            */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function setExecutionAdapter(address asset, IExecutionAdapter adapter) external onlyConfig {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        adapter.validateExecutionAdapter(asset);

        executionAdapterOf[asset] = adapter;
        emit EventsLib.ExecutionAdapterSet(asset, address(adapter));
    }

    /* -------------------------------------------------------------------------- */
    /*                  INTERNAL STATES ORCHESTRATOR FUNCTIONS                    */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function advanceIdlePhase() external onlyInternalStatesOrchestrator {
        currentPhase = LiquidityUpkeepPhase.SellingLeg;
    }

    /* -------------------------------------------------------------------------- */
    /*                                VAULT FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function returnDepositFunds(address user, uint256 amount) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        // Transfer funds back to the user
        IERC20(underlyingAsset).safeTransfer(user, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function transferCuratorFees(uint256 amount) external {
        address vault = msg.sender;

        if (!config.isOrionVault(vault) && !config.isDecommissionedVault(vault)) revert ErrorsLib.NotAuthorized();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        // Transfer underlying assets to the vault owner
        address vaultOwner = IOrionVault(vault).vaultOwner();
        IERC20(underlyingAsset).safeTransfer(vaultOwner, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function transferRedemptionFunds(address user, uint256 amount) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        // Transfer underlying assets to the user
        IERC20(underlyingAsset).safeTransfer(user, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function withdraw(uint256 assets, address receiver) external nonReentrant {
        if (!config.isDecommissionedVault(msg.sender)) revert ErrorsLib.NotAuthorized();

        IERC20(underlyingAsset).safeTransfer(receiver, assets);
    }

    /* -------------------------------------------------------------------------- */
    /*                                UPKEEP FUNCTIONS                            */
    /* -------------------------------------------------------------------------- */

    /// @notice Checks if the upkeep is needed
    /// @return upkeepNeeded Whether the upkeep is needed
    /// @return performData Empty bytes
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            upkeepNeeded = true;
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            upkeepNeeded = true;
        } else if (currentPhase == LiquidityUpkeepPhase.FulfillDepositAndRedeem) {
            upkeepNeeded = true;
        } else {
            upkeepNeeded = false;
        }
        performData = "";
    }

    /// @notice Performs the upkeep
    function performUpkeep(bytes calldata) external override onlyAuthorizedTrigger nonReentrant whenNotPaused {
        if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            _processSellLeg();
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            _processBuyLeg();
        } else if (currentPhase == LiquidityUpkeepPhase.FulfillDepositAndRedeem) {
            _processFulfillDepositAndRedeem();
            internalStatesOrchestrator.updateNextUpdateTime();
        }

        emit EventsLib.PortfolioRebalanced();
    }

    /* -------------------------------------------------------------------------- */
    /*                                INTERNAL FUNCTIONS                          */
    /* -------------------------------------------------------------------------- */

    /// @notice Handles the sell action
    function _processSellLeg() internal {
        (
            address[] memory sellingTokens,
            uint256[] memory sellingAmounts,
            uint256[] memory sellingEstimatedUnderlyingAmounts
        ) = internalStatesOrchestrator.getOrders(true);

        currentPhase = LiquidityUpkeepPhase.BuyingLeg;

        for (uint16 i = 0; i < sellingTokens.length; ++i) {
            address token = sellingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = sellingAmounts[i];
            _executeSell(token, amount, sellingEstimatedUnderlyingAmounts[i]);
        }
    }

    /// @notice Handles the buy action
    function _processBuyLeg() internal {
        (
            address[] memory buyingTokens,
            uint256[] memory buyingAmounts,
            uint256[] memory buyingEstimatedUnderlyingAmounts
        ) = internalStatesOrchestrator.getOrders(false);

        currentPhase = LiquidityUpkeepPhase.FulfillDepositAndRedeem;

        for (uint16 i = 0; i < buyingTokens.length; ++i) {
            address token = buyingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = buyingAmounts[i];
            _executeBuy(token, amount, buyingEstimatedUnderlyingAmounts[i]);
        }

        // slither-disable-next-line reentrancy-no-eth
        internalStatesOrchestrator.updateBufferAmount(deltaBufferAmount);
        deltaBufferAmount = 0;
    }

    /// @notice Executes a sell order
    /// @param asset The asset to sell
    /// @param sharesAmount The amount of shares to sell
    /// @param estimatedUnderlyingAmount The estimated underlying amount to receive
    function _executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        IERC20(asset).forceApprove(address(adapter), sharesAmount);

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        uint256 executionUnderlyingAmount = adapter.sell(asset, sharesAmount);

        // Clean up approval
        IERC20(asset).forceApprove(address(adapter), 0);

        deltaBufferAmount += int256(executionUnderlyingAmount) - int256(estimatedUnderlyingAmount);
    }

    /// @notice Executes a buy order
    /// @param asset The asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    /// @dev The adapter now handles slippage tolerance internally based on configured slippageTolerance
    function _executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Calculate maximum spend with appropriate buffer
        // The adapter will pull this amount and return any excess
        // Use 3x multiplier as base safety factor to account for:
        // 1. Price divergence between estimation time and execution time
        // 2. Vault-specific fees, rounding, or exchange rate changes
        // 3. Additional slippage tolerance for market impact (if configured)
        uint256 maxAcceptableSpend = slippageTolerance > 0
            ? (estimatedUnderlyingAmount * 3 * (10000 + slippageTolerance)) / 10000
            : estimatedUnderlyingAmount * 5;

        // Approve adapter to spend underlying assets (limited to max acceptable spend)
        IERC20(underlyingAsset).forceApprove(address(adapter), maxAcceptableSpend);

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        uint256 executionUnderlyingAmount = adapter.buy(asset, sharesAmount);

        // Clean up approval
        IERC20(underlyingAsset).forceApprove(address(adapter), 0);

        deltaBufferAmount += int256(estimatedUnderlyingAmount) - int256(executionUnderlyingAmount);
    }

    /// @notice Handles the fulfill deposit and redeem actions
    function _processFulfillDepositAndRedeem() internal {
        // Process transparent vaults
        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);

        uint16 i0 = currentMinibatchIndex * minibatchSize;
        uint16 i1 = i0 + minibatchSize;
        ++currentMinibatchIndex;

        if (i1 > transparentVaults.length || i1 == transparentVaults.length) {
            i1 = uint16(transparentVaults.length);
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address vault = transparentVaults[i];
            uint256 totalAssetsForDeposit = internalStatesOrchestrator.getVaultTotalAssetsForFulfillDeposit(vault);
            uint256 totalAssetsForRedeem = internalStatesOrchestrator.getVaultTotalAssetsForFulfillRedeem(vault);

            _processVaultDepositAndRedeem(vault, totalAssetsForDeposit, totalAssetsForRedeem);
            if (config.isDecommissioningVault(vault)) {
                config.completeVaultDecommissioning(vault);
            }
        }
    }

    /// @notice Processes deposit and redeem operations for a single vault
    /// @param vault The vault address
    /// @param totalAssetsForDeposit The total assets for deposit operations
    /// @param totalAssetsForRedeem The total assets for redeem operations
    function _processVaultDepositAndRedeem(
        address vault,
        uint256 totalAssetsForDeposit,
        uint256 totalAssetsForRedeem
    ) internal {
        IOrionVault vaultContract = IOrionVault(vault);

        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        uint256 pendingRedeem = vaultContract.pendingRedeem(maxFulfillBatchSize);
        uint256 pendingDeposit = vaultContract.pendingDeposit(maxFulfillBatchSize);

        if (pendingRedeem > 0) {
            vaultContract.fulfillRedeem(totalAssetsForRedeem);
        }

        if (pendingDeposit > 0) {
            vaultContract.fulfillDeposit(totalAssetsForDeposit);
        }
    }

    /// @inheritdoc ILiquidityOrchestrator
    function pause() external onlyConfig {
        _pause();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function unpause() external onlyConfig {
        _unpause();
    }
}
