// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
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
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IInternalStateOrchestrator
{
    using EnumerableMap for EnumerableMap.AddressToUintMap;

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

    /// @notice Initial batch portfolio (w_0) - mapping of token address to estimated value [assets]
    EnumerableMap.AddressToUintMap internal _initialBatchPortfolioHat;

    /// @notice Final batch portfolio (w_1) - mapping of token address to estimated value [assets]
    EnumerableMap.AddressToUintMap internal _finalBatchPortfolioHat;

    // TODO: encrypted batched portfolio to be summed up in Zama coprocessor and then added to the batchPortfolio.
    // mapping(address => euint32) internal _encryptedBatchPortfolio;

    function initialize(address initialOwner, address automationRegistry_, address config_) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

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

        // Reset the batch portfolios (remove all previous entries)
        _initialBatchPortfolioHat.clear();
        _finalBatchPortfolioHat.clear();

        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        uint256 length = transparentVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);

            (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

            // Calculate estimated active total assets (t_1) and populate batch portfolio
            uint256 t1Hat = 0;
            uint256 portfolioLength = portfolioTokens.length;
            for (uint256 j = 0; j < portfolioLength; j++) {
                address token = portfolioTokens[j];
                uint256 price = registry.price(token);
                uint256 value = price * sharesPerAsset[j];
                t1Hat += value;

                // Update existing value or insert if not present
                (bool exists, uint256 currentValue) = _initialBatchPortfolioHat.tryGet(token);
                if (exists) {
                    _initialBatchPortfolioHat.set(token, currentValue + value);
                } else {
                    _initialBatchPortfolioHat.set(token, value);
                }
            }

            uint256 pendingWithdrawalsHat = vault.convertToAssetsWithPITTotalAssets(
                vault.getPendingWithdrawals(),
                t1Hat,
                Math.Rounding.Floor
            );

            // Calculate estimated (active and passive) total assets (t_2)
            uint256 t2Hat = t1Hat + vault.getPendingDeposits() - pendingWithdrawalsHat;

            (address[] memory intentTokens, uint256[] memory intentWeights) = vault.getIntent();

            uint256 intentLength = intentTokens.length;
            for (uint256 j = 0; j < intentLength; j++) {
                address token = intentTokens[j];
                uint256 weight = intentWeights[j];
                uint256 value = t2Hat * weight;

                (bool exists, uint256 currentValue) = _finalBatchPortfolioHat.tryGet(token);
                if (exists) {
                    _finalBatchPortfolioHat.set(token, currentValue + value);
                } else {
                    _finalBatchPortfolioHat.set(token, value);
                }
            }
        }

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        length = encryptedVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);

            (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();
            // TODO: add entry point for Zama coprocessor for both dot product and batching operations.
        }

        emit EventsLib.InternalStateProcessed(epochCounter);
        // TODO: have additional chainlink automation offchain process
        // triggered by this event and triggering liquidity orchestrator.
        // Move to liquidity orchestrator:
        // Process delta_W, WR, DR. Here I use p_t. // TODO: investigate DR/W netting.
        // delta_W = W_1 - W_0
        // _processVaultStates();
        // TODO. Be sure to remove unused functions across contracts,
        // there may be, given the current degree of refactoring.
    }

    function getInitialBatchPortfolioHat() external view returns (address[] memory tokens, uint256[] memory values) {
        uint256 length = _initialBatchPortfolioHat.length();
        address[] memory tokens_ = new address[](length);
        uint256[] memory values_ = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            (address key, uint256 value) = _initialBatchPortfolioHat.at(i);
            tokens_[i] = key;
            values_[i] = value;
        }
        return (tokens_, values_);
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
