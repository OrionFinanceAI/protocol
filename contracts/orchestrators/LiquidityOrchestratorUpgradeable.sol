// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title Liquidity Orchestrator
 * @notice Contract that orchestrates liquidity operations
 * @author Orion Finance
 * @dev This contract is responsible for:
 *      - Executing actual buy and sell orders on investment universe;
 *      - Processing withdrawal requests from LPs;
 *      - Handling slippage and market execution differences from adapter price estimates via liquidity buffer.
 * @custom:security-contact security@orionfinance.ai
 */
contract LiquidityOrchestratorUpgradeable is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ILiquidityOrchestrator
{
    using Math for uint256;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Basis points factor
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;

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

    /// @notice Counter for tracking processing cycles
    uint16 public epochCounter;

    /// @notice Minibatch size for fulfill deposit and redeem processing
    uint8 public minibatchSize;

    /// @notice Upkeep phase
    LiquidityUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice Target buffer ratio
    uint256 public targetBufferRatio;

    /// @notice Slippage tolerance
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

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract
    /// @param initialOwner The address of the initial owner
    /// @param config_ The address of the OrionConfig contract
    /// @param automationRegistry_ The address of the Chainlink Automation Registry
    function initialize(address initialOwner, address config_, address automationRegistry_) public initializer {
        if (initialOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        config = IOrionConfig(config_);
        underlyingAsset = address(config.underlyingAsset());
        admin = config.admin();

        automationRegistry = automationRegistry_;
        currentPhase = LiquidityUpkeepPhase.Idle;
        minibatchSize = 1;
        slippageTolerance = 0;
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
    function setTargetBufferRatio(uint256 _targetBufferRatio) external onlyOwner {
        if (_targetBufferRatio == 0) revert ErrorsLib.InvalidArguments();
        // 5%
        if (_targetBufferRatio > 500) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        targetBufferRatio = _targetBufferRatio;
        slippageTolerance = _targetBufferRatio / 2;
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
        if (currentPhase == LiquidityUpkeepPhase.Idle) {
            currentPhase = LiquidityUpkeepPhase.SellingLeg;
        }
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
        } else if (currentPhase == LiquidityUpkeepPhase.ProcessVaultOperations) {
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
        } else if (currentPhase == LiquidityUpkeepPhase.ProcessVaultOperations) {
            _processVaultOperations();
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

        currentPhase = LiquidityUpkeepPhase.ProcessVaultOperations;

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
        uint256 executionUnderlyingAmount = adapter.sell(asset, sharesAmount, estimatedUnderlyingAmount);

        // Clean up approval
        IERC20(asset).forceApprove(address(adapter), 0);

        deltaBufferAmount += executionUnderlyingAmount.toInt256() - estimatedUnderlyingAmount.toInt256();
    }

    /// @notice Executes a buy order
    /// @param asset The asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    /// @dev The adapter handles slippage tolerance internally.
    function _executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend underlying assets
        IERC20(underlyingAsset).forceApprove(
            address(adapter),
            estimatedUnderlyingAmount.mulDiv(BASIS_POINTS_FACTOR + slippageTolerance, BASIS_POINTS_FACTOR)
        );

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        uint256 executionUnderlyingAmount = adapter.buy(asset, sharesAmount, estimatedUnderlyingAmount);

        // Clean up approval
        IERC20(underlyingAsset).forceApprove(address(adapter), 0);

        deltaBufferAmount += estimatedUnderlyingAmount.toInt256() - executionUnderlyingAmount.toInt256();
    }

    /// @notice Handles the vault operations
    function _processVaultOperations() internal {
        // Process transparent vaults
        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);

        uint16 i0 = currentMinibatchIndex * minibatchSize;
        uint16 i1 = i0 + minibatchSize;
        ++currentMinibatchIndex;

        if (i1 > transparentVaults.length || i1 == transparentVaults.length) {
            i1 = uint16(transparentVaults.length);
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
            emit EventsLib.EpochProcessed(epochCounter);
            ++epochCounter;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address vault = transparentVaults[i];
            (
                uint256 totalAssetsForRedeem,
                uint256 totalAssetsForDeposit,
                uint256 finalTotalAssets
            ) = internalStatesOrchestrator.getVaultTotalAssetsAll(vault);

            _processSingleVaultOperations(vault, totalAssetsForDeposit, totalAssetsForRedeem, finalTotalAssets);
        }
    }

    /// @notice Processes deposit and redeem operations for a single vault
    /// @param vault The vault address
    /// @param totalAssetsForDeposit The total assets for deposit operations
    /// @param totalAssetsForRedeem The total assets for redeem operations
    function _processSingleVaultOperations(
        address vault,
        uint256 totalAssetsForDeposit,
        uint256 totalAssetsForRedeem,
        uint256 finalTotalAssets
    ) internal {
        IOrionTransparentVault vaultContract = IOrionTransparentVault(vault);

        if (internalStatesOrchestrator.processLP()) {
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

        (address[] memory tokens, uint256[] memory shares) = internalStatesOrchestrator.getVaultPortfolio(vault);
        vaultContract.updateVaultState(tokens, shares, finalTotalAssets);

        if (config.isDecommissioningVault(vault)) {
            for (uint16 i = 0; i < tokens.length; ++i) {
                if (tokens[i] == address(underlyingAsset)) {
                    if (shares[i] == finalTotalAssets) {
                        config.completeVaultDecommissioning(vault);
                        break;
                    }
                }
            }
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

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
