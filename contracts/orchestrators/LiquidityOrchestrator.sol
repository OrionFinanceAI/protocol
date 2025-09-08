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
import "../interfaces/IOrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/IExecutionAdapter.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title Liquidity Orchestrator
 * @notice Contract that orchestrates liquidity operations and vault state updates
 * @author Orion Finance
 * @dev This contract is responsible for:
 *      - Executing actual buy and sell orders on investment universe;
 *      - Processing actual curator fees with vaults and protocol fees;
 *      - Processing deposit and withdrawal requests from LPs;
 *      - Updating vault states post-execution (checks-effects-interactions pattern at the protocol level);
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

    /// @notice Execution adapters mapping for assets
    mapping(address => IExecutionAdapter) public executionAdapterOf;

    /* -------------------------------------------------------------------------- */
    /*                               UPKEEP STATE                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Last processed epoch counter from Internal States Orchestrator
    uint16 public lastProcessedEpoch;

    /// @notice Execution minibatch size
    uint8 public executionMinibatchSize;

    /// @notice Upkeep phase
    LiquidityUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice Slippage bound in basis points
    uint256 public slippageBound;

    /// @notice Target buffer ratio
    uint256 public targetBufferRatio;

    /// @notice Action constants for checkUpkeep and performUpkeep
    bytes4 private constant ACTION_START = bytes4(keccak256("start()"));
    bytes4 private constant ACTION_PROCESS_SELL = bytes4(keccak256("processSell(uint8)"));
    bytes4 private constant ACTION_PROCESS_BUY = bytes4(keccak256("processBuy(uint8)"));
    // TODO: add state update action(s).

    /* -------------------------------------------------------------------------- */
    /*                                MODIFIERS                                   */
    /* -------------------------------------------------------------------------- */

    /// @dev Restricts function to only Chainlink Automation Registry
    modifier onlyAutomationRegistry() {
        if (msg.sender != automationRegistry) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only Orion Config contract
    modifier onlyConfig() {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
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

        automationRegistry = automationRegistry_;
        lastProcessedEpoch = 0;
        currentPhase = LiquidityUpkeepPhase.Idle;
        executionMinibatchSize = 1;
        currentMinibatchIndex = 0;
    }

    /* -------------------------------------------------------------------------- */
    /*                                OWNER FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function updateExecutionMinibatchSize(uint8 _executionMinibatchSize) external onlyOwner {
        if (_executionMinibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        executionMinibatchSize = _executionMinibatchSize;
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
    function setSlippageBound(uint256 _slippageBound) external onlyOwner {
        if (_slippageBound == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        slippageBound = _slippageBound;
        targetBufferRatio = slippageBound.mulDiv(1100, 1000);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function claimProtocolFees(uint256 amount) external onlyOwner {
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

        executionAdapterOf[asset] = adapter;
        emit EventsLib.ExecutionAdapterSet(asset, address(adapter));
    }

    /// @inheritdoc ILiquidityOrchestrator
    function unsetExecutionAdapter(address asset) external onlyConfig {
        if (asset == address(0)) revert ErrorsLib.ZeroAddress();

        delete executionAdapterOf[asset];
        emit EventsLib.ExecutionAdapterSet(asset, address(0));
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

        if (!config.isOrionVault(vault)) revert ErrorsLib.NotAuthorized();
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
        }
        // TODO: add state update action(s).
        else {
            upkeepNeeded = false;
            performData = "";
        }
    }

    /// @notice Performs the upkeep
    function performUpkeep(bytes calldata performData) external override onlyAutomationRegistry nonReentrant {
        if (performData.length < 4) revert ErrorsLib.InvalidArguments();

        (bytes4 action, uint8 minibatchIndex) = abi.decode(performData, (bytes4, uint8));

        if (action == ACTION_START) {
            _handleStart();
        } else if (action == ACTION_PROCESS_SELL) {
            _processMinibatchSell(minibatchIndex);
        } else if (action == ACTION_PROCESS_BUY) {
            _processMinibatchBuy(minibatchIndex);
        }
        // TODO: add state update action(s).

        // TODO: buy and sell orders all in shares at this point, fix execution adapter API accordingly.
        // this implies we can match intents with adapter price and use those variables to update vault states
        // we nonetheless do this update after the actual execution, in line with a re-entrancy protection design.
        // Here we are dealing with multiple transactions, not a single one, so the pattern has not the same use.

        // Execute sequentially the trades to reach target state
        (address[] memory sellingTokens, uint256[] memory sellingAmounts) = internalStatesOrchestrator
            .getSellingOrders();
        // TODO: can here the returned value be zero? If so fix in internal states orchestrator.
        // TODO: same for buying orders.

        // TODO: use executionMinibatchSize, akin to internal states orchestrator.

        // TODO: analogous to internal state orchestrator,
        // TODO: store underlying asset as contract variable at construction to avoid gas.
        // if (token == address(config.underlyingAsset())) pass for both sell and buy

        // Sell before buy, avoid undercollateralization risk.
        for (uint16 i = 0; i < sellingTokens.length; ++i) {
            address token = sellingTokens[i];
            uint256 amount = sellingAmounts[i];
            _executeSell(token, amount);
            // TODO: every transaction should enable the update of the buffer liquidity,
            // making use of the average execution price,
            // and the oracle prices used to generate the orders.
        }

        (address[] memory buyingTokens, uint256[] memory buyingAmounts) = internalStatesOrchestrator.getBuyingOrders();

        for (uint16 i = 0; i < buyingTokens.length; ++i) {
            address token = buyingTokens[i];
            uint256 amount = buyingAmounts[i];
            _executeBuy(token, amount);
        }

        // TODO: StateUpdate phase start, refacto.
        // // Consistency between operation orders in internal states orchestrator and here is crucial.

        // address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        // uint16 length = uint16(transparentVaults.length);
        // // TODO: implement.
        // // for (uint16 i = 0; i < length; i++) {
        // //     IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);
        // //     vault.updateVaultState(?, ?);
        // // }

        // // TODO: to updateVaultState of encrypted vaults, get the encrypted sharesPerAsset executed by the liquidity
        // // TODO: skip updating encrypted vaults states for which if (!vault.isIntentValid()), see other orchestrator.

        // address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        // length = uint16(encryptedVaults.length);
        // // TODO: implement.
        // // for (uint16 i = 0; i < length; i++) {
        // //     IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);
        // //     vault.updateVaultState(?, ?);
        // // }

        // TODO: DepositRequest and RedeemRequest in Vaults to be processed post update
        // (internal logic depends on vaults actual total assets and total supply
        // (inside the _convertToShares, _mint, _burn and _convertToAssets calls), and removed from
        // vault state as pending requests. Opportunity to net actual transactions (not just intents),
        // performing minting and burning operation at the same time.

        // TODO: call updateHighWaterMark. Works only if actual vault states updated,
        // ok to use real total assets/share price there, but then this update shall
        // be done after all other states updates for convertToAssets to work.

        // TODO: update pendingCuratorFees calling accrueCuratorFees of each vault.
        // Use the value computed in internal states orchestrator.

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
        currentPhase = LiquidityUpkeepPhase.SellingLeg;
    }

    /// @notice Handles the sell action
    function _processMinibatchSell(uint8 minibatchIndex) internal {
        // TODO: implement.
    }

    /// @notice Handles the buy action
    function _processMinibatchBuy(uint8 minibatchIndex) internal {
        // TODO: implement.
    }

    /// @notice Executes a sell order
    /// @param asset The asset to sell
    /// @param amount The amount of shares to sell
    function _executeSell(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        bool success = IERC20(asset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // TODO: pass slippageBound, oracle price and number of shares to adapters.

        // TODO: not performing trade if slippage is too high, record we still have
        // the open position.

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        adapter.sell(asset, amount);
    }

    /// @notice Executes a buy order
    /// @param asset The asset to buy
    /// @param amount The amount of shares to buy
    function _executeBuy(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // TODO: analogous API updates as sell.
        // TODO: underlying asset/numeraire needs to be part of the whitelisted investment universe,
        // as if an order does not pass the underlying equivalent
        // is set into the portfolio state for all vaults.

        // Approve adapter to spend underlying assets
        bool success = IERC20(underlyingAsset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        adapter.buy(asset, amount);
    }
}
