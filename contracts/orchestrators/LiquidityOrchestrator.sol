// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
contract LiquidityOrchestrator is Ownable, ReentrancyGuard, ILiquidityOrchestrator {
    using Math for uint256;

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

    /// @notice Last processed epoch counter from Internal States Orchestrator
    uint16 public lastProcessedEpoch;

    /// @notice Execution minibatch size
    uint8 public executionMinibatchSize;

    /// @notice Minibatch size for fulfill deposit and redeem processing
    uint8 public minibatchSize;

    /// @notice Upkeep phase
    LiquidityUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice Target buffer ratio
    uint256 public targetBufferRatio;

    /// @notice Maximum execution minibatch size
    uint8 public constant MAX_EXECUTION_MINIBATCH_SIZE = 8;
    /// @notice Maximum minibatch size
    uint8 public constant MAX_MINIBATCH_SIZE = 8;

    /// @notice Action constants for checkUpkeep and performUpkeep
    bytes4 private constant ACTION_START = bytes4(keccak256("start()"));
    bytes4 private constant ACTION_PROCESS_SELL = bytes4(keccak256("processSell(uint8)"));
    bytes4 private constant ACTION_PROCESS_BUY = bytes4(keccak256("processBuy(uint8)"));
    bytes4 private constant ACTION_PROCESS_FULFILL_DEPOSIT_AND_REDEEM =
        bytes4(keccak256("processFulfillDepositAndRedeem()"));

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */

    /// @notice Selling tokens for current epoch
    address[] public sellingTokens;
    /// @notice Selling amounts for current epoch
    uint256[] public sellingAmounts;
    /// @notice Selling underlying amounts for current epoch
    uint256[] public sellingEstimatedUnderlyingAmounts;
    /// @notice Buying tokens for current epoch
    address[] public buyingTokens;
    /// @notice Buying amounts for current epoch
    uint256[] public buyingAmounts;
    /// @notice Buying underlying amounts for current epoch
    uint256[] public buyingEstimatedUnderlyingAmounts;

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
        if (msg.sender != admin) revert ErrorsLib.UnauthorizedAccess();
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
        lastProcessedEpoch = 0;
        currentPhase = LiquidityUpkeepPhase.Idle;
        executionMinibatchSize = 1;
        minibatchSize = 1;
        currentMinibatchIndex = 0;
    }

    /* -------------------------------------------------------------------------- */
    /*                                OWNER FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function updateExecutionMinibatchSize(uint8 _executionMinibatchSize) external onlyOwner {
        if (_executionMinibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (_executionMinibatchSize > MAX_EXECUTION_MINIBATCH_SIZE) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        executionMinibatchSize = _executionMinibatchSize;
    }

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
    function setTargetBufferRatio(uint256 _targetBufferRatio) external onlyOwner {
        if (_targetBufferRatio == 0) revert ErrorsLib.InvalidArguments();
        // 5%
        if (_targetBufferRatio > 500) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        targetBufferRatio = _targetBufferRatio;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function depositLiquidity(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (internalStatesOrchestrator.currentPhase() != IInternalStateOrchestrator.InternalUpkeepPhase.Idle)
            revert ErrorsLib.SystemNotIdle();

        // Transfer underlying assets from the admin to this contract
        bool success = IERC20(underlyingAsset).transferFrom(msg.sender, address(this), amount);
        if (!success) revert ErrorsLib.TransferFailed();

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
        bool success = IERC20(underlyingAsset).transfer(msg.sender, amount);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function claimProtocolFees(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        internalStatesOrchestrator.subtractPendingProtocolFees(amount);

        bool success = IERC20(underlyingAsset).transfer(msg.sender, amount);
        if (!success) revert ErrorsLib.TransferFailed();
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
    /*                                VAULT FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function returnDepositFunds(address user, uint256 amount) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        // Transfer funds back to the user
        bool success = IERC20(underlyingAsset).transfer(user, amount);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function transferCuratorFees(uint256 amount) external {
        address vault = msg.sender;

        if (!config.isOrionVault(vault) && !config.isDecommissionedVault(vault)) revert ErrorsLib.NotAuthorized();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        // Transfer underlying assets to the vault owner
        address vaultOwner = IOrionVault(vault).vaultOwner();
        bool success = IERC20(underlyingAsset).transfer(vaultOwner, amount);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function transferRedemptionFunds(address user, uint256 amount) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        // Transfer underlying assets to the user
        bool success = IERC20(underlyingAsset).transfer(user, amount);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function withdraw(uint256 assets, address receiver) external nonReentrant {
        if (!config.isDecommissionedVault(msg.sender)) revert ErrorsLib.NotAuthorized();

        SafeERC20.safeTransfer(IERC20(underlyingAsset), receiver, assets);
    }

    /* -------------------------------------------------------------------------- */
    /*                                UPKEEP FUNCTIONS                            */
    /* -------------------------------------------------------------------------- */

    /// @notice Checks if the upkeep is needed
    /// @return upkeepNeeded Whether the upkeep is needed
    /// @return performData The data to perform the upkeep
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (config.isSystemIdle() && internalStatesOrchestrator.epochCounter() > lastProcessedEpoch) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_START, uint8(0));
        } else if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_PROCESS_SELL, currentMinibatchIndex);
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_PROCESS_BUY, currentMinibatchIndex);
        } else if (currentPhase == LiquidityUpkeepPhase.FulfillDepositAndRedeem) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_PROCESS_FULFILL_DEPOSIT_AND_REDEEM, currentMinibatchIndex);
        } else {
            upkeepNeeded = false;
            performData = "";
        }
    }

    /// @notice Performs the upkeep
    /// @param performData The encoded data containing the action and minibatch index
    function performUpkeep(bytes calldata performData) external override onlyAuthorizedTrigger nonReentrant {
        if (performData.length < 5) revert ErrorsLib.InvalidArguments();

        (bytes4 action, uint8 minibatchIndex) = abi.decode(performData, (bytes4, uint8));

        if (action == ACTION_START) {
            _handleStart();
        } else if (action == ACTION_PROCESS_SELL) {
            _processMinibatchSell(minibatchIndex);
        } else if (action == ACTION_PROCESS_BUY) {
            _processMinibatchBuy(minibatchIndex);
        } else if (action == ACTION_PROCESS_FULFILL_DEPOSIT_AND_REDEEM) {
            _processFulfillDepositAndRedeem(minibatchIndex);
        }
        emit EventsLib.PortfolioRebalanced();
    }

    /* -------------------------------------------------------------------------- */
    /*                                INTERNAL FUNCTIONS                          */
    /* -------------------------------------------------------------------------- */

    /// @notice Handles the start action
    function _handleStart() internal {
        uint16 currentEpoch = internalStatesOrchestrator.epochCounter();
        if (currentEpoch < lastProcessedEpoch + 1) {
            return;
        }
        lastProcessedEpoch = currentEpoch;

        // Clear previous epoch data
        delete sellingTokens;
        delete sellingAmounts;
        delete buyingTokens;
        delete buyingAmounts;
        delete sellingEstimatedUnderlyingAmounts;
        delete buyingEstimatedUnderlyingAmounts;
        deltaBufferAmount = 0;
        // Populate new epoch data
        (
            sellingTokens,
            sellingAmounts,
            buyingTokens,
            buyingAmounts,
            sellingEstimatedUnderlyingAmounts,
            buyingEstimatedUnderlyingAmounts
        ) = internalStatesOrchestrator.getOrders();

        currentPhase = LiquidityUpkeepPhase.SellingLeg;
        if (sellingTokens.length == 0) {
            currentPhase = LiquidityUpkeepPhase.BuyingLeg;
            if (buyingTokens.length == 0) {
                currentPhase = LiquidityUpkeepPhase.Idle;
            }
        }
    }

    /// @notice Handles the sell action
    /// @param minibatchIndex The index of the minibatch to process
    function _processMinibatchSell(uint8 minibatchIndex) internal {
        if (currentPhase != LiquidityUpkeepPhase.SellingLeg) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * executionMinibatchSize;
        uint16 i1 = i0 + executionMinibatchSize;

        if (i1 > sellingTokens.length || i1 == sellingTokens.length) {
            i1 = uint16(sellingTokens.length);
            currentPhase = LiquidityUpkeepPhase.BuyingLeg;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address token = sellingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = sellingAmounts[i];
            _executeSell(token, amount, sellingEstimatedUnderlyingAmounts[i]);
        }
    }

    /// @notice Handles the buy action
    /// @param minibatchIndex The index of the minibatch to process
    function _processMinibatchBuy(uint8 minibatchIndex) internal {
        if (currentPhase != LiquidityUpkeepPhase.BuyingLeg) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * executionMinibatchSize;
        uint16 i1 = i0 + executionMinibatchSize;

        if (i1 > buyingTokens.length || i1 == buyingTokens.length) {
            i1 = uint16(buyingTokens.length);
            currentPhase = LiquidityUpkeepPhase.FulfillDepositAndRedeem;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address token = buyingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = buyingAmounts[i];
            _executeBuy(token, amount, buyingEstimatedUnderlyingAmounts[i]);
        }

        if (i1 == buyingTokens.length) {
            internalStatesOrchestrator.updateBufferAmount(deltaBufferAmount);
        }
    }

    /// @notice Executes a sell order
    /// @param asset The asset to sell
    /// @param sharesAmount The amount of shares to sell
    /// @param estimatedUnderlyingAmount The estimated underlying amount to receive
    function _executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        // slither-disable-next-line unused-return
        IERC20(asset).approve(address(adapter), 0);
        // slither-disable-next-line unused-return
        IERC20(asset).approve(address(adapter), sharesAmount);

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        uint256 executionUnderlyingAmount = adapter.sell(asset, sharesAmount);

        deltaBufferAmount += int256(executionUnderlyingAmount) - int256(estimatedUnderlyingAmount);
    }

    /// @notice Executes a buy order
    /// @param asset The asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    function _executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend underlying assets
        // slither-disable-next-line unused-return
        IERC20(underlyingAsset).approve(address(adapter), 0);

        // slither-disable-next-line unused-return
        IERC20(underlyingAsset).approve(address(adapter), estimatedUnderlyingAmount * 2);

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        uint256 executionUnderlyingAmount = adapter.buy(asset, sharesAmount);

        deltaBufferAmount += int256(estimatedUnderlyingAmount) - int256(executionUnderlyingAmount);
    }

    /// @notice Handles the fulfill deposit and redeem actions
    /// @param minibatchIndex The index of the minibatch to process
    function _processFulfillDepositAndRedeem(uint8 minibatchIndex) internal {
        if (currentPhase != LiquidityUpkeepPhase.FulfillDepositAndRedeem) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;

        // Process transparent vaults
        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);

        uint16 i0 = minibatchIndex * minibatchSize;
        uint16 i1 = i0 + minibatchSize;

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

        // Check if vault has pending deposits and redemptions
        uint256 pendingDeposit = vaultContract.pendingDeposit();
        uint256 pendingRedeem = vaultContract.pendingRedeem();

        // Process deposits if pending
        if (pendingDeposit > 0) {
            vaultContract.fulfillDeposit(totalAssetsForDeposit);
        }

        // Process redemptions if pending
        if (pendingRedeem > 0) {
            vaultContract.fulfillRedeem(totalAssetsForRedeem);
        }
    }
}
