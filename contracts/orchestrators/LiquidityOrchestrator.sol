// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
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
 * @dev This contract is responsible for:
 *      - Executing actual buy and sell orders on investment universe;
 *      - Processing actual curator fees with vaults and protocol fees;
 *      - Processing deposit and withdrawal requests from LPs;
 *      - Updating vault states (post-execution, checks-effects-interactions pattern at the protocol level);
 *      - Handling slippage and market execution differences from adapter estimates via liquidity buffer.
 */
contract LiquidityOrchestrator is Ownable, ILiquidityOrchestrator {
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

    /// @notice Upkeep phase
    LiquidityUpkeepPhase public currentPhase;

    /// @notice Execution minibatch size
    uint8 public executionMinibatchSize;

    /* -------------------------------------------------------------------------- */
    /*                               MODIFIERS                                  */
    /* -------------------------------------------------------------------------- */

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyAutomationRegistry() {
        if (msg.sender != automationRegistry) revert ErrorsLib.NotAuthorized();
        _;
    }

    modifier onlyConfig() {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
        _;
    }

    constructor(address initialOwner, address config_, address automationRegistry_) Ownable(initialOwner) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(config_);
        internalStatesOrchestrator = IInternalStateOrchestrator(config.internalStatesOrchestrator());
        underlyingAsset = address(config.underlyingAsset());

        automationRegistry = automationRegistry_;
        lastProcessedEpoch = 0;
        currentPhase = LiquidityUpkeepPhase.Idle;
        executionMinibatchSize = 1;
    }

    /// @notice Updates the orchestrator from the config contract
    /// @dev This function is called by the owner to update the orchestrator
    ///      when the config contract is updated.
    function updateFromConfig() public onlyOwner {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        internalStatesOrchestrator = IInternalStateOrchestrator(config.internalStatesOrchestrator());
        underlyingAsset = address(config.underlyingAsset());
    }

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
        uint16 currentEpoch = internalStatesOrchestrator.epochCounter();
        if (currentEpoch > lastProcessedEpoch && config.isSystemIdle()) {
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
        uint16 currentEpoch = internalStatesOrchestrator.epochCounter();
        if (currentEpoch <= lastProcessedEpoch) {
            return;
        }
        lastProcessedEpoch = currentEpoch;

        // Measure initial underlying balance of this contract.
        // uint256 initialUnderlyingBalance = IERC20(underlyingAsset).balanceOf(address(this));

        // TODO: buy and sell orders all in shares at this point, fix execution adapter API accordingly.
        // this implies we can match intents with adapter price and use those variables to update vault states
        // we nonetheless do this update after the actual execution, in line with a re-entrancy protection design.
        // Here we are dealing with multiple transactions, not a single one, so the pattern has not the same use.

        // Execute sequentially the trades to reach target state
        // (consider having the number of standing orders as a trigger of a set of chainlink automation jobs).
        // for more scalable market interactions.
        (address[] memory sellingTokens, uint256[] memory sellingAmounts) = internalStatesOrchestrator
            .getSellingOrders();

        // TODO: use executionMinibatchSize, akin to internal states orchestrator.

        // TODO: analogous to internal state orchestrator,
        // if (token == address(config.underlyingAsset())) pass for both sell and buy

        // Sell before buy, avoid undercollateralization risk.
        for (uint16 i = 0; i < sellingTokens.length; i++) {
            address token = sellingTokens[i];
            uint256 amount = sellingAmounts[i];
            _executeSell(token, amount);
        }

        // Measure intermediate underlying balance of this contract.
        // uint256 intermediateUnderlyingBalance = IERC20(underlyingAsset).balanceOf(address(this));

        (address[] memory buyingTokens, uint256[] memory buyingAmounts) = internalStatesOrchestrator.getBuyingOrders();

        for (uint16 i = 0; i < buyingTokens.length; i++) {
            address token = buyingTokens[i];
            uint256 amount = buyingAmounts[i];
            _executeBuy(token, amount);
        }

        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        uint16 length = uint16(transparentVaults.length);
        for (uint16 i = 0; i < length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);
            // TODO: implement.
            // vault.updateVaultState(?, ?);
        }

        // TODO: to updateVaultState of encrypted vaults, get the encrypted sharesPerAsset executed by the liquidity

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        length = uint16(encryptedVaults.length);
        for (uint16 i = 0; i < length; i++) {
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
        // is set into the portfolio state for all vaults.

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        adapter.sell(asset, amount);
    }

    // TODO: docs when implemented.
    function _executeBuy(address asset, uint256 amount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend underlying assets
        bool success = IERC20(underlyingAsset).approve(address(adapter), amount);
        if (!success) revert ErrorsLib.TransferFailed();

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        adapter.buy(asset, amount);
    }
}
