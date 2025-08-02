// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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

/// @title Liquidity Orchestrator
/// @dev This contract is responsible for:
///      - Executing actual buy and sell orders on investment universe;
///      - Processing actual curator fees with vaults and protocol fees;
///      - Processing deposit and withdrawal requests from LPs;
///      - Updating vault states (post-execution, checks-effects-interactions pattern at the protocol level);
///      - Handling slippage and market execution differences from adapter estimates via liquidity buffer.
contract LiquidityOrchestrator is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ILiquidityOrchestrator {
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
    /// @notice Upkeep phase
    enum UpkeepPhase {
        Idle,
        SellingLeg,
        BuyingLeg,
        StateUpdate
    }

    /// @notice Last processed epoch counter from Internal States Orchestrator
    uint256 public lastProcessedEpoch;

    /// @notice Upkeep phase
    UpkeepPhase public currentPhase;

    /// @notice Number of orders processed in the current leg
    uint256 public processedLegOrders;

    function initialize(address initialOwner, address automationRegistry_, address config_) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();

        automationRegistry = automationRegistry_;
        config = IOrionConfig(config_);
        internalStatesOrchestrator = IInternalStateOrchestrator(config.internalStatesOrchestrator());

        underlyingAsset = address(config.underlyingAsset());

        lastProcessedEpoch = 0;

        currentPhase = UpkeepPhase.Idle;
        processedLegOrders = 0;
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyAutomationRegistry() {
        if (msg.sender != automationRegistry) revert ErrorsLib.NotAuthorized();
        _;
    }

    modifier onlyConfig() {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateAutomationRegistry(address newAutomationRegistry) external onlyOwner {
        if (newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        automationRegistry = newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(newAutomationRegistry);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateConfig(address newConfig) external onlyOwner {
        if (newConfig == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(newConfig);
    }

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

    /// @inheritdoc ILiquidityOrchestrator
    function returnDepositFunds(address user, uint256 amount) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        // Transfer funds back to the user
        bool success = IERC20(underlyingAsset).transfer(user, amount);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function returnWithdrawShares(address user, uint256 shares) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();

        // Get the vault's share token address
        address shareToken = address(msg.sender);

        // Transfer shares back to the user
        bool success = IERC20(shareToken).transfer(user, shares);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    // TODO: docs when implemented.
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256 currentEpoch = internalStatesOrchestrator.epochCounter();
        if (currentEpoch > lastProcessedEpoch && currentPhase == UpkeepPhase.Idle) {
            upkeepNeeded = true;
            // TODO: same as internal states orchestrator, use bytes4 and encodePacked.
            performData = abi.encode("start");
        }
        // TODO: ...
        else {
            upkeepNeeded = false;
            performData = "";
        }
    }

    // TODO: refacto for scalability, same as internal states orchestrator.
    // TODO: docs when implemented.
    function performUpkeep(bytes calldata) external override onlyAutomationRegistry {
        uint256 currentEpoch = internalStatesOrchestrator.epochCounter();
        if (currentEpoch <= lastProcessedEpoch) {
            return;
        }
        lastProcessedEpoch = currentEpoch;

        // Measure initial underlying balance of this contract.
        uint256 initialUnderlyingBalance = IERC20(underlyingAsset).balanceOf(address(this));

        // TODO: buy and sell orders all in shares at this point, fix execution adapter API accordingly.
        // this implies we can match intents with adapter price and use those variables to update vault states
        // we nonetheless do this update after the actual execution, in line with a re-entrancy protection design.
        // Here we are dealing with multiple transactions, not a single one, so the pattern has not the same use.

        // Execute sequentially the trades to reach target state
        // (consider having the number of standing orders as a trigger of a set of chainlink automation jobs).
        // for more scalable market interactions.
        (address[] memory sellingTokens, uint256[] memory sellingAmounts) = internalStatesOrchestrator
            .getSellingOrders();

        // Sell before buy, avoid undercollateralization risk.
        for (uint256 i = 0; i < sellingTokens.length; i++) {
            address token = sellingTokens[i];
            uint256 amount = sellingAmounts[i];
            _executeSell(token, amount);
        }

        // TODO: Execution methodology could go further than batched buy/sell,
        // breaking down each selling/buying order into multiple transactions,
        // minimizing liquidity orchestrator market impact.

        // Measure intermediate underlying balance of this contract.
        uint256 intermediateUnderlyingBalance = IERC20(underlyingAsset).balanceOf(address(this));

        // Compute tracking error.
        // ||Delta_S||_L1
        uint256 executedUnderlyingSellAmount = intermediateUnderlyingBalance - initialUnderlyingBalance;
        // ||Delta_S_hat||_L1
        uint256 expectedUnderlyingSellAmount = internalStatesOrchestrator.expectedUnderlyingSellAmount();
        uint256 epsilon = executedUnderlyingSellAmount - expectedUnderlyingSellAmount;

        // ||Delta_B_hat||_L1
        uint256 expectedUnderlyingBuyAmount = internalStatesOrchestrator.expectedUnderlyingBuyAmount();

        // Tracking error factor gamma
        uint256 trackingErrorFactor = 1e18;
        if (expectedUnderlyingBuyAmount > 0) {
            trackingErrorFactor = 1e18 + (epsilon * 1e18) / expectedUnderlyingBuyAmount;
        }

        (address[] memory buyingTokens, uint256[] memory buyingAmounts) = internalStatesOrchestrator.getBuyingOrders();
        // Scaling the buy leg to absorb the tracking error, protecting LPs from execution slippage.
        // This is a global compensation factor, applied uniformly to all vaults, it ensures full collateralization
        // of the overall portfolio.
        for (uint256 i = 0; i < buyingTokens.length; i++) {
            buyingAmounts[i] = (buyingAmounts[i] * trackingErrorFactor) / 1e18;
        }

        for (uint256 i = 0; i < buyingTokens.length; i++) {
            address token = buyingTokens[i];
            uint256 amount = buyingAmounts[i];
            _executeBuy(token, amount);
        }

        // As per the portfolio states, we can distribute the tracking error to each vault
        // with a weight proportional to t_1.
        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        uint256 length = transparentVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);
            // TODO: implement.
            // vault.updateVaultState(?, ?);
        }

        // TODO: to updateVaultState of encrypted vaults, get the encrypted sharesPerAsset executed by the liquidity

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        length = encryptedVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);
            // TODO: implement.
            // vault.updateVaultState(?, ?);
        }

        // TODO: DepositRequest and WithdrawRequest in Vaults to be processed post t0 update, and removed from
        // vault state as pending requests.
        // Opportunity to net actual transactions (not just intents),
        // performing minting and burning operation at the same time.
        // TODO: process curators (sending underlying to vault as escrow for curator to redeem)
        // and protocol fees to separate escrow/wallet.

        emit EventsLib.PortfolioRebalanced();
    }

    // TODO: docs when implemented.
    function _executeSell(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        bool success = IERC20(asset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // TODO: setting slippage tolerance at the protocol level,
        // passing adapter price for specific asset to execution adapter,
        // and not performing trade if slippage is too high.
        // TODO: same for buy orders.

        // TODO: underlying asset/numeraire needs to be part of the whitelisted investment universe,
        // as if an order does not pass the underlying equivalent
        // is set into the portfolio state for all vaults. As before, clear how to handle this point with privacy.

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        adapter.sell(asset, amount);
    }

    // TODO: docs when implemented.
    function _executeBuy(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Get the underlying asset from the adapter (assumes it's an ERC4626 adapter)
        // TODO: fix, This declaration shadows an existing declaration.
        address underlyingAsset = IERC4626(asset).asset();

        // Approve adapter to spend underlying assets
        bool success = IERC20(underlyingAsset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        adapter.buy(asset, amount);
    }
}
