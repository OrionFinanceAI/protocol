// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IOrionTransparentVault.sol";
import "./interfaces/IOrionEncryptedVault.sol";
import "./interfaces/IOracleRegistry.sol";
import "./interfaces/IInternalStateOrchestrator.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

/// @title Internal States Orchestrator
/// @notice Orchestrates state reading and estimation operations triggered by Chainlink Automation
/// @dev This contract is responsible for:
///      - Reading current vault states and market data
///      - Computing state estimations for Liquidity Orchestrator
///      - Emitting events to trigger the Liquidity Orchestrator
///
///      IMPORTANT: This contract does NOT execute transactions or write vault states.
///      It only performs read operations and calculations to estimate state changes.
///      Actual state modifications and transaction execution are handled by the
///      Liquidity Orchestrator contract.
///      Variable naming distinguishes measurements (x) from estimations (x_hat).
contract InternalStatesOrchestrator is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    IInternalStateOrchestrator
{
    /// @notice Timestamp when the next upkeep is allowed
    uint256 public nextUpdateTime;

    /// @notice Interval in seconds between upkeeps
    uint256 public constant updateInterval = 1 minutes;

    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Counter for tracking processing cycles
    uint256 public epochCounter;

    function initialize(address initialOwner, address automationRegistry_, address config_) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _transferOwnership(initialOwner);

        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        automationRegistry = automationRegistry_;
        config = IOrionConfig(config_);

        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
        epochCounter = 0;
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
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
        config = IOrionConfig(newConfig);
    }

    /// @notice Checks if upkeep is needed based on time interval
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        upkeepNeeded = _shouldTriggerUpkeep();

        performData = bytes("");
        // NOTE: we can compute here all read-only states to generate payload to then pass to performUpkeep
        // https://docs.chain.link/chainlink-automation/reference/automation-interfaces
        // Losing atomicity, but better for scalability.
    }

    /// @notice Performs state reading and estimation operations
    /// @dev This function:
    ///      - Reads current vault states and oracle prices;
    ///      - Computes estimated system states;
    ///      - Emits events to trigger the Liquidity Orchestrator
    function performUpkeep(bytes calldata) external override onlyAutomationRegistry nonReentrant {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
        epochCounter++;

        IOracleRegistry registry = IOracleRegistry(config.oracleRegistry());

        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaults.length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);

            (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

            // TODO: refacto t1 and t2 computation into vault contract.
            // Feat: curator to be able to call estimated current total supply (t2) to inform their trades,
            // which is ALSO (not only) used by the internal state orchestrator
            // to inform the trades of the liquidity orchestrator.

            // Calculate estimated active total assets (t_1)
            uint256 t1Hat = 0;
            for (uint256 j = 0; j < portfolioTokens.length; j++) {
                address token = portfolioTokens[j];
                uint256 sharesPerAsset_ = sharesPerAsset[j];
                t1Hat += registry.price(token) * sharesPerAsset_;
            }

            // Calculate estimated (active and passive) total assets (t_2)

            // TODO: add input to convertToAssets function, so that we can pass intermediate total assets as input.
            // WR_a = _convertToAssets(WR, t_1) [assets]

            // W_0 = sum(t_1 * w_0)

            // t_2 = t_1 + DR_a - WR_a
            // W_1 = sum(t_2 * w_1)

            // delta_W = W_1 - W_0
            // _processVaultStates();
            // TODO. Be sure to remove unused functions across contracts,
            // there may be, given the current degree of refactoring.
        }

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        for (uint256 i = 0; i < encryptedVaults.length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);

            (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();
            // TODO: add entry point for Zama coprocessor for both dot product and batching operations.
            portfolioTokens;
            sharesPerAsset;
        }

        emit EventsLib.InternalStateProcessed(epochCounter);
        // TODO: have additional chainlink automation offchain process
        // triggered by this event and triggering liquidity orchestrator.
        // Move to liquidity orchestrator:
        // Process delta_W, WR, DR. Here I use p_t. // TODO: investigate DR/W netting.
    }

    /// @notice Computes the next update time based on current timestamp
    /// @param currentTime Current block timestamp
    /// @return Next update time
    function _computeNextUpdateTime(uint256 currentTime) internal pure returns (uint256) {
        return currentTime + updateInterval;
    }

    /// @notice Checks if upkeep should be triggered based on time
    /// @return True if upkeep should be triggered
    function _shouldTriggerUpkeep() internal view returns (bool) {
        // slither-disable-next-line timestamp
        return block.timestamp >= nextUpdateTime;
    }
}
