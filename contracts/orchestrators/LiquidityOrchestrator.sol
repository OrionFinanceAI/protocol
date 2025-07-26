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
/// @notice Orchestrates transaction execution and vault state modifications
/// @dev This contract is responsible for:
///      - Executing actual transactions on vaults and external protocols
///      - Processing deposit and withdrawal requests from vaults
///      - Writing and updating vault states based on executed transactions
///      - Handling slippage and market execution differences from oracle estimates
///      - Managing curator fees.
///
///      IMPORTANT: This contract is triggered by the Internal States Orchestrator
///      and is responsible for all state-modifying operations.
///      The Internal States Orchestrator only reads states and performs estimations.
///      This contract handles the actual execution and state writing.
///
///      Note: The post execution portfolio state may differ from the intent
///      not only due to slippage, but also because asset prices can evolve
///      between the oracle call and execution.
contract LiquidityOrchestrator is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ILiquidityOrchestrator {
    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Internal States Orchestrator contract address
    IInternalStateOrchestrator public internalStatesOrchestrator;

    /// @notice Execution adapters mapping for assets
    mapping(address => IExecutionAdapter) public executionAdapterOf;

    /// @notice Last processed epoch counter from Internal States Orchestrator
    uint256 public lastProcessedEpoch;

    function initialize(address initialOwner, address automationRegistry_, address config_) external initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();

        automationRegistry = automationRegistry_;
        config = IOrionConfig(config_);
        internalStatesOrchestrator = IInternalStateOrchestrator(config.internalStatesOrchestrator());

        lastProcessedEpoch = 0;
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

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external onlyOwner {
        if (newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        automationRegistry = newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(newAutomationRegistry);
    }

    /// @notice Updates the Orion Config contract address
    /// @param newConfig The new config address
    function updateConfig(address newConfig) external onlyOwner {
        if (newConfig == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(newConfig);
    }

    /// @notice Register or replace the adapter for an asset.
    /// @param asset The address of the asset
    /// @param adapter The execution adapter for the asset
    function setAdapter(address asset, IExecutionAdapter adapter) external onlyOwner {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        executionAdapterOf[asset] = adapter;
        emit EventsLib.AdapterSet(asset, address(adapter));
    }

    /// @notice Return deposit funds to a user who cancelled their deposit request
    /// @dev Called by vault contracts when users cancel deposit requests
    /// @param user The user to return funds to
    /// @param amount The amount to return
    function returnDepositFunds(address user, uint256 amount) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();

        // TODO: set this in the constructor from the config, not here.
        // Get the underlying asset from the vault
        address underlyingAsset = IOrionVault(msg.sender).asset();

        // Transfer funds back to the user
        bool success = IERC20(underlyingAsset).transfer(user, amount);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Return withdrawal shares to a user who cancelled their withdrawal request
    /// @dev Called by vault contracts when users cancel withdrawal requests
    /// @param user The user to return shares to
    /// @param shares The amount of shares to return
    function returnWithdrawShares(address user, uint256 shares) external {
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();

        // Get the vault's share token address
        address shareToken = address(msg.sender);

        // Transfer shares back to the user
        bool success = IERC20(shareToken).transfer(user, shares);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Checks if upkeep is needed by comparing epoch counters
    /// @return upkeepNeeded True if rebalancing is needed
    /// @return performData Data to pass to performUpkeep
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        uint256 currentEpoch = internalStatesOrchestrator.epochCounter();

        upkeepNeeded = currentEpoch > lastProcessedEpoch;

        performData = bytes("");
        // NOTE: we can compute here all read-only states to generate payload to then pass to performUpkeep
        // https://docs.chain.link/chainlink-automation/reference/automation-interfaces
        // Losing atomicity, but better for scalability.
    }

    /// @notice Performs the rebalancing.
    function performUpkeep(bytes calldata) external override onlyAutomationRegistry {
        uint256 currentEpoch = internalStatesOrchestrator.epochCounter();
        if (currentEpoch <= lastProcessedEpoch) {
            return;
        }
        lastProcessedEpoch = currentEpoch;

        // Measure initial underlying balance of this contract.
        // TODO: set this in the constructor from the config, not here.
        address underlyingAsset = address(config.underlyingAsset());
        uint256 initialUnderlyingBalance = IERC20(underlyingAsset).balanceOf(address(this));

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

        // Naive execution methodology objective to avoid undercollateralization:
        // ||Delta_B||_L1 - ||Delta_S||_L1 = ||Delta_B_hat||_L1 - ||Delta_S_hat||_L1 = ||Delta_W_hat||_L1
        // ====> ||Delta_W||_L1 = ||Delta_W_hat||_L1
        // Given, because of oracle missestimations/slippage:
        // ||Delta_S||_L1 = ||Delta_S_hat||_L1 + epsilon
        // Delta_B := gamma * Delta_B_hat
        // ====> gamma = (1 + epsilon / ||Delta_B_hat||_L1)

        // TODO: current logic does not enable calibration error treatment if there are
        // no selling errors, please fix.

        // TODO: in the future, the size of N-1 standing orders are sequentially recalibrated
        // using the measurement from the current execution, breaking down each asset into a transaction.abi
        // This could go further, breaking down each selling/buying order into multiple transactions,
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

        // This approach leads to preserved sum of total assets.
        // This gives, for each vault: t_1 = t1Hat, giving actual vaults minting/burning ratio as the estimated one.

        // TODO: for the following, consider avoiding redistributing the tracking error,
        // and setting dust portfolio as "reminder" state in the orchestrator.
        // Even in that case, we need to backpropagate the tracking error to account for
        // it in the next epoch t1Hat estimation.

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
        // orchestrator and update the vault intent with an encrypted calibration error before storing it.
        // Not trivial how to backpropagate the calibration error to each vault.
        // Identify metodology to do this maintaining privacy.

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        length = encryptedVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);
            // TODO: implement.
            // vault.updateVaultState(?, ?);
        }

        // TODO: DepositRequest and WithdrawRequest in Vaults to be processed post t0 update, and removed from
        // vault state as pending requests.
        // Opportunity to net transaction? Perform minting and burning operation at the same time.

        // TODO: process curators and protocol fees.

        emit EventsLib.PortfolioRebalanced();
    }

    /// @notice Internal function to execute a sell order directly through the adapter
    /// @param asset The address of the asset to sell
    /// @param amount The amount of shares to sell
    function _executeSell(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        bool success = IERC20(asset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        adapter.sell(asset, amount);
    }

    /// @notice Internal function to execute a buy order directly through the adapter
    /// @param asset The address of the asset to buy
    /// @param amount The amount of underlying assets to use for buying
    function _executeBuy(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Get the underlying asset from the adapter (assumes it's an ERC4626 adapter)
        address underlyingAsset = IERC4626(asset).asset();

        // Approve adapter to spend underlying assets
        bool success = IERC20(underlyingAsset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        adapter.buy(asset, amount);
    }
}
