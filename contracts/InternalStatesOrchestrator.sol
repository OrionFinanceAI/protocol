// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IMarketOracle.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

/// @title Internal States Orchestrator
/// @notice Orchestrates internal state transitions triggered by Chainlink Automation
/// @dev This contract manages periodic updates of vault states and market data through Chainlink Automation
contract InternalStatesOrchestrator is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    AutomationCompatibleInterface,
    ReentrancyGuardUpgradeable
{
    /// @notice Timestamp when the next upkeep is allowed
    uint256 public nextUpdateTime;

    /// @notice Interval in seconds between upkeeps
    uint256 public constant UPDATE_INTERVAL = 1 minutes;

    /// @notice Chainlink Automation Registry address
    address public registry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Emitted when internal states are processed
    event InternalStateProcessed(uint256 timestamp);

    /// @notice Emitted when the Chainlink Automation Registry address is updated
    event RegistryUpdated(address indexed newRegistry);

    function initialize(address initialOwner, address _registry, address _config) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _transferOwnership(initialOwner);

        if (_registry == address(0)) revert ErrorsLib.ZeroAddress();
        registry = _registry;
        config = IOrionConfig(_config);

        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyRegistry() {
        if (msg.sender != registry) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Updates the Chainlink Automation Registry address
    /// @param _newRegistry The new registry address
    function updateRegistry(address _newRegistry) external onlyOwner {
        if (_newRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        registry = _newRegistry;
        emit RegistryUpdated(_newRegistry);
    }

    /// @notice Updates the Orion Config contract address
    /// @param _newConfig The new config address
    function updateConfig(address _newConfig) external onlyOwner {
        config = IOrionConfig(_newConfig);
    }

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        upkeepNeeded = _shouldTriggerUpkeep();
        performData = bytes("");
        // TODO: compute here all read-only states to generate payload to then pass to performUpkeep
        // https://docs.chain.link/chainlink-automation/reference/automation-interfaces
        // Losing atomicity, not sure if best approach.
        // get previousPriceArray from oracle here.
        return (upkeepNeeded, performData);
    }

    /// @notice Called by Chainlink Automation to execute internal state logic
    function performUpkeep(bytes calldata) external override onlyRegistry nonReentrant {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();

        // 1. Collect states from market oracle
        IMarketOracle oracle = config.marketOracle();
        // TODO: break down following function to have a read-only query
        // and another which is actually writing to the oracle state latest price.
        (uint256[] memory previousPriceArray, uint256[] memory currentPriceArray) = oracle.getPrices();

        // Calculate P&L based on price changes
        uint256[] memory pnlAmountArray = _calculatePnL(previousPriceArray, currentPriceArray);

        // 2. Collect states from all Orion vaults
        (
            address[] memory vaults,
            uint256[] memory sharePrices,
            uint256[] memory totalAssets,
            uint256[] memory depositRequests,
            uint256[] memory withdrawRequests
        ) = config.getVaultStates();

        // 3. Update internal state BEFORE external calls (EFFECTS before INTERACTIONS)
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);

        // 4. Calculate P&L and update vault states based on market data
        for (uint256 i = 0; i < vaults.length; i++) {
            // Validate vault address before making external calls
            if (vaults[i] == address(0)) revert ErrorsLib.ZeroAddress();

            IOrionVault vault = IOrionVault(vaults[i]);

            uint256 pnlAmount = pnlAmountArray[i];

            // Calculate new total assets: current + deposits - withdrawals + P&L
            uint256 newTotalAssets = totalAssets[i] + depositRequests[i] - withdrawRequests[i] + pnlAmount;

            // Calculate new share price based on P&L
            uint256 newSharePrice = sharePrices[i] * (1 + pnlAmount);

            // TODO: https://github.com/crytic/slither/wiki/Detector-Documentation/#calls-inside-a-loop
            vault.updateVaultState(newSharePrice, newTotalAssets, pnlAmount);
        }

        emit InternalStateProcessed(block.timestamp);

        // TODO: consider having another offchain process
        // (potentially again chainlink automation) listening to this event
        // and updating the liquidity positions in another transaction.
        // No atomicity, but better for scalability. To be discussed.
        // 6. Trigger Liquidity Orchestrator to update liquidity positions based on updated internal states.
        // TODO: Implement liquidity orchestrator trigger
    }

    function _shouldTriggerUpkeep() internal view returns (bool) {
        return block.timestamp >= nextUpdateTime;
    }

    function _computeNextUpdateTime(uint256 currentTime) internal pure returns (uint256) {
        return currentTime + UPDATE_INTERVAL;
    }

    function _calculatePnL(
        uint256[] memory previousPriceArray,
        uint256[] memory currentPriceArray
    ) internal pure returns (uint256[] memory pnlAmountArray) {
        pnlAmountArray = new uint256[](previousPriceArray.length);
        for (uint256 i = 0; i < previousPriceArray.length; i++) {
            pnlAmountArray[i] = (currentPriceArray[i] - previousPriceArray[i]) / previousPriceArray[i];
        }
    }
}
