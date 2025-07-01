// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IOracleRegistry.sol";
import "./interfaces/IInternalStateOrchestrator.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

/// @title Internal States Orchestrator
/// @notice Orchestrates internal state transitions triggered by Chainlink Automation
/// @dev This contract manages periodic updates of vault states and market data through Chainlink Automation
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
    uint256 public constant UPDATE_INTERVAL = 1 minutes;

    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice P&L array
    PnL[] public pnlArray;

    function initialize(address initialOwner, address automationRegistry_, address config_) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _transferOwnership(initialOwner);

        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        automationRegistry = automationRegistry_;
        config = IOrionConfig(config_);

        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

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

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        upkeepNeeded = _shouldTriggerUpkeep();

        performData = bytes("");
        // NOTE: we can compute here all read-only states to generate payload to then pass to performUpkeep
        // https://docs.chain.link/chainlink-automation/reference/automation-interfaces
        // Losing atomicity, but better for scalability.
        return (upkeepNeeded, performData);
    }

    /// @notice Called by Chainlink Automation to execute internal state logic
    function performUpkeep(bytes calldata) external override onlyAutomationRegistry nonReentrant {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();

        // Update internal state BEFORE external calls (EFFECTS before INTERACTIONS)
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);

        // Process vault states
        _processVaultStates();

        emit EventsLib.InternalStateProcessed(block.timestamp);

        // TODO: have another chainlink automation offchain process
        // listening to this event and updating the liquidity positions
        //in another transaction based on the updated internal states.
        // No atomicity, but better for scalability.
    }

    /// @notice Process vault states by updating oracle prices and calculating P&L
    function _processVaultStates() internal {
        // Collect read-only states from all Orion vaults
        (
            address[] memory vaults,
            uint256[] memory sharePrices,
            uint256[] memory totalAssets,
            uint256[] memory depositRequests,
            uint256[] memory withdrawRequests
        ) = config.getVaultStates();

        // Clear the storage array
        delete pnlArray;
        // Update oracle prices and calculate P&L
        PnL[] memory pnlMemory = _updateOraclePricesAndCalculatePnL();

        // Copy memory array to storage array
        for (uint256 i = 0; i < pnlMemory.length; i++) {
            pnlArray.push(pnlMemory[i]);
        }

        // Update vault states
        _updateVaultStates(vaults, sharePrices, totalAssets, depositRequests, withdrawRequests, pnlArray);
    }

    /// @notice Update oracle prices and calculate P&L based on price changes
    function _updateOraclePricesAndCalculatePnL() internal returns (PnL[] memory) {
        address[] memory universe = config.getAllWhitelistedAssets();
        IOracleRegistry registry = IOracleRegistry(config.oracleRegistry());

        uint256[] memory previousPriceArray = new uint256[](universe.length);
        uint256[] memory currentPriceArray = new uint256[](universe.length);

        for (uint256 i = 0; i < universe.length; i++) {
            // slither-disable-start calls-loop
            previousPriceArray[i] = registry.price(universe[i]);
            currentPriceArray[i] = registry.update(universe[i]);
            // slither-disable-end calls-loop
        }

        return _calculatePnL(previousPriceArray, currentPriceArray);
    }

    /// @notice Update vault states based on market data and pending operations
    function _updateVaultStates(
        address[] memory vaults,
        uint256[] memory sharePrices,
        uint256[] memory totalAssets,
        uint256[] memory depositRequests,
        uint256[] memory withdrawRequests,
        PnL[] memory pnlMem
    ) internal {
        for (uint256 i = 0; i < vaults.length; i++) {
            // slither-disable-start calls-loop
            // Validate vault address before making external calls
            if (vaults[i] == address(0)) revert ErrorsLib.ZeroAddress();

            IOrionVault vault = IOrionVault(vaults[i]);

            // TODO: compute vault absolute pnl performing dot product between
            // the vault's weights and the pnl amount array.
            // Multiplied by the vault's total assets.
            // TODO: this requires to have the executed vault weights in the vault state.
            // Best to overwrite this state from the liquidity orchestrator.
            // uint256 pnlAmount = pnlMem[i] * totalAssets[i]; // TODO: placeholder, to be removed

            // // Calculate new share price based on P&L [%]
            // uint256 newSharePrice = (sharePrices[i] * (10 ** config.statesDecimals() + pnlAmountArray[i])) /
            //     10 ** config.statesDecimals();

            // // TODO: compute new deposit requests in shares? Needed for total supply calculation.
            // // uint256 newDepositRequests = vault.convertToShares(depositRequests[i]);

            // uint256 withdrawalAssets = vault.convertToAssets(withdrawRequests[i]);
            // uint256 newTotalAssets = totalAssets[i] + depositRequests[i] - withdrawalAssets + pnlAmount;

            // vault.updateVaultState(newSharePrice, newTotalAssets);
            // slither-disable-end calls-loop
        }
    }

    function _shouldTriggerUpkeep() internal view returns (bool) {
        // slither-disable-next-line timestamp
        return block.timestamp >= nextUpdateTime;
    }

    function _computeNextUpdateTime(uint256 currentTime) internal pure returns (uint256) {
        return currentTime + UPDATE_INTERVAL;
    }

    /// @notice Calculates the percentage change (P&L) between previous and current prices
    /// @param prev Array of previous prices
    /// @param curr Array of current prices
    /// @return pnlMem Array of P&L percentages [%]
    function _calculatePnL(uint256[] memory prev, uint256[] memory curr) internal view returns (PnL[] memory pnlMem) {
        uint256 len = prev.length;
        pnlMem = new PnL[](len);
        uint8 statesDecimals = config.statesDecimals();

        for (uint256 i = 0; i < len; i++) {
            uint256 oldP = prev[i];
            uint256 newP = curr[i];

            bool isPos = newP >= oldP;
            uint256 diff = isPos ? (newP - oldP) : (oldP - newP);
            uint256 pct = (diff * 10 ** statesDecimals) / oldP;

            pnlMem[i] = PnL({ pctChange: pct, isPositive: isPos });
        }
    }
}
