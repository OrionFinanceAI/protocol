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
contract LiquidityOrchestrator is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ILiquidityOrchestrator {
    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Internal States Orchestrator contract address
    IInternalStateOrchestrator public internalStatesOrchestrator;

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

        // TODO:
        // 1. Get delta portfolio in underlying asset from inner state orchestrator.
        // 2. Get desired USD target allocations (based on estimated prices)
        // 3. Calculate target shares for all but last asset (using priceOracle.getPrice)
        // 4. Adjust last asset target shares post N-1 executions for rounding/trade error
        // 5. Execute trades to reach target shares via executeTrade()

        // TODO: vault states t0, w_0 to be updated at the end of the execution.
        // TODO: required to have the executed vault states (in shares) in the vault state.
        // Overwrite this state from the liquidity orchestrator.
        // TODO: DepositRequest and WithdrawRequest in Vaults to be
        // processed (post t0 update) and removed from vault state as pending requests.
        // TODO: curator fees to be paid at the end of the execution.
        // In the liquidity orchestrator, document that the post execution
        // portfolio state is different from the intent one not only
        // because of slippage, but also because the assets prices have
        // evolved between the oracle call and the execution call.

        (address[] memory tokens, uint256[] memory values) = internalStatesOrchestrator.getPriceEstimates();

        (address[] memory initialTokens, uint256[] memory initialValues) = internalStatesOrchestrator
            .getInitialBatchPortfolioHat();
        (address[] memory finalTokens, uint256[] memory finalValues) = internalStatesOrchestrator
            .getFinalBatchPortfolioHat();

        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        uint256 length = transparentVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);
            vault.updateVaultState(new IOrionTransparentVault.Position[](0), 0); // TODO: implement.
        }

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        length = encryptedVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);
            vault.updateVaultState(new IOrionEncryptedVault.EncryptedPosition[](0), 0); // TODO: implement.
        }

        emit EventsLib.PortfolioRebalanced();
    }
}
