// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IOracleRegistry.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

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
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    function initialize(address initialOwner, address _automationRegistry, address _config) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _transferOwnership(initialOwner);

        if (_automationRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        automationRegistry = _automationRegistry;
        config = IOrionConfig(_config);

        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyAutomationRegistry() {
        if (msg.sender != automationRegistry) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Updates the Chainlink Automation Registry address
    /// @param _newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address _newAutomationRegistry) external onlyOwner {
        if (_newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        automationRegistry = _newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(_newAutomationRegistry);
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
        return (upkeepNeeded, performData);
    }

    /// @notice Called by Chainlink Automation to execute internal state logic
    function performUpkeep(bytes calldata) external override onlyAutomationRegistry nonReentrant {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();

        // Collect read-only states from all Orion vaults
        (
            address[] memory vaults,
            uint256[] memory sharePrices,
            uint256[] memory totalAssets,
            uint256[] memory depositRequests,
            uint256[] memory withdrawRequests
        ) = config.getVaultStates();

        // Update internal state BEFORE external calls (EFFECTS before INTERACTIONS)
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);

        // Collect read-write states from market oracle
        address[] memory universe = config.getAllWhitelistedAssets();
        IOracleRegistry registry = IOracleRegistry(config.oracleRegistry());

        uint256[] memory previousPriceArray = new uint256[](universe.length);
        uint256[] memory currentPriceArray = new uint256[](universe.length);
        for (uint256 i = 0; i < universe.length; i++) {
            previousPriceArray[i] = registry.price(universe[i]);
            currentPriceArray[i] = registry.update(universe[i]);
        }

        // Calculate P&L based on price changes
        uint256[] memory pnlAmountArray = _calculatePnL(previousPriceArray, currentPriceArray);

        // Calculate P&L and update vault states based on market data
        for (uint256 i = 0; i < vaults.length; i++) {
            // Validate vault address before making external calls
            if (vaults[i] == address(0)) revert ErrorsLib.ZeroAddress();

            IOrionVault vault = IOrionVault(vaults[i]);

            uint256 pnlAmount = pnlAmountArray[i];

            // Calculate new total assets: current + deposits - withdrawals + P&L
            uint256 newTotalAssets = totalAssets[i] + depositRequests[i] - withdrawRequests[i] + pnlAmount;

            // Calculate new share price based on P&L
            uint256 newSharePrice = sharePrices[i] * (1 + pnlAmount);

            vault.updateVaultState(newSharePrice, newTotalAssets);
        }

        emit EventsLib.InternalStateProcessed(block.timestamp);

        // TODO: have another chainlink automation offchain process
        // listening to this event and updating the liquidity positions
        //in another transaction based on the updated internal states.
        // No atomicity, but better for scalability.
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
