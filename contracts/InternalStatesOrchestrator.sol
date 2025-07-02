// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IOrionTransparentVault.sol";
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

    /// @notice P&L mapping - asset address to (signed) percentage change
    mapping(address => int256) public pctChange;

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
        // Update oracle prices and calculate P&L
        _updateOraclePricesAndCalculatePnL();

        address[] memory transparentVaults = config.getAllOrionVaults(false);
        // address[] memory encryptedVaults = config.getAllOrionVaults(true); // TODO: add encrypted vaults support.
        // TODO: add entry point for Zama coprocessor for both dot product and batching.

        for (uint256 i = 0; i < transparentVaults.length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);
            uint256 t0 = vault.totalAssets();
            (address[] memory portfolioTokens, uint256[] memory portfolioWeights) = vault.getPortfolio();
            uint256 t1 = t0 * onePlusDotProduct(portfolioTokens, portfolioWeights);

            // TODO: add input to convertToAssets function, so that we can pass intermediate total assets as input.
            // W_a = _convertToAssets(W, t_1) [assets]

            // P_0 = sum(t_1 * p_0)

            // t_2 = t_1 + D - W_a
            // P_1 = sum(t_2 * p_1)

            // delta_P = P_1 - P_0
            // _processVaultStates();
            // TODO. Be sure to remove unused functions across contracts, there may be, given the degree of refactoring of today.
        }

        emit EventsLib.InternalStateProcessed(block.timestamp);
        // TODO: have additional chainlink automation offchain process triggered by this event and triggering liquidity orchestrator.
        // Move to liquidity orchestrator:
        // Process delta_P, W, D. Here I use prices_t. // TODO: investigate D/W netting.
    }

    function _computeNextUpdateTime(uint256 currentTime) internal pure returns (uint256) {
        return currentTime + UPDATE_INTERVAL;
    }
    function _shouldTriggerUpkeep() internal view returns (bool) {
        // slither-disable-next-line timestamp
        return block.timestamp >= nextUpdateTime;
    }

    /// @notice Update oracle prices and calculate P&L based on price changes
    function _updateOraclePricesAndCalculatePnL() internal {
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

        _calculatePnL(universe, previousPriceArray, currentPriceArray);
    }

    /// @notice Calculates the percentage change (P&L) between previous and current prices
    /// @param assets_ Array of assets
    /// @param prev Array of previous prices
    /// @param curr Array of current prices
    function _calculatePnL(address[] memory assets_, uint256[] memory prev, uint256[] memory curr) internal {
        uint256 len = assets_.length;
        uint256 statesDecimals = config.statesDecimals();
        uint256 precision = 10 ** statesDecimals;

        for (uint256 i = 0; i < len; i++) {
            uint256 oldP = prev[i];
            uint256 newP = curr[i];

            // Handle price changes with proper overflow protection
            if (newP >= oldP) {
                // Price increased or stayed the same
                uint256 diff = newP - oldP;
                int256 pct = int256((diff * precision) / oldP);
                pctChange[assets_[i]] = pct;
            } else {
                // Price decreased - handle negative percentage
                uint256 diff = oldP - newP;
                int256 pct = -int256((diff * precision) / oldP);
                pctChange[assets_[i]] = pct;
            }
        }
    }

    /// @notice Calculates 1 + dot product of portfolio weights and percentage changes
    /// @param portfolioTokens_ Array of portfolio token addresses
    /// @param portfolioWeights_ Array of portfolio weights
    /// @return The result of 1 + dot product calculation
    function onePlusDotProduct(
        address[] memory portfolioTokens_,
        uint256[] memory portfolioWeights_
    ) internal view returns (uint256) {
        uint256 statesDecimals = config.statesDecimals();
        uint256 precision = 10 ** statesDecimals;
        uint256 sum = precision; // Start with 1 in the precision format

        for (uint256 i = 0; i < portfolioWeights_.length; i++) {
            address token = portfolioTokens_[i];
            uint256 weight = portfolioWeights_[i];
            int256 pctChangeValue = pctChange[token];

            // Handle positive and negative percentage changes separately to keep sum unsigned.
            if (pctChangeValue >= 0) {
                uint256 product = weight * uint256(pctChangeValue);
                sum += product;
            } else {
                // Negative change - subtract from sum (but ensure we don't underflow)
                uint256 absProduct = weight * uint256(-pctChangeValue);
                if (sum < absProduct) revert ErrorsLib.Underflow();
                sum -= absProduct;
            }
        }
        return sum;
    }

    /// @notice Update vault states based on market data and pending operations
    // function _updateVaultStates(
    //     address[] memory vaults,
    //     uint256[] memory totalAssets,
    //     uint256[] memory depositRequests,
    //     uint256[] memory withdrawRequests,
    //     PnL[] memory pnlMem
    // ) internal {
    //     for (uint256 i = 0; i < vaults.length; i++) {
    //         // slither-disable-start calls-loop
    //         IOrionVault vault = IOrionVault(vaults[i]);

    //         // TODO: compute vault absolute pnl performing dot product between
    //         // the vault's weights and the pnl amount array.
    //         // Multiplied by the vault's total assets.
    //         // TODO: this requires to have the executed vault weights in the vault state.
    //         // Best to overwrite this state from the liquidity orchestrator.
    //         // uint256 pnlAmount = pnlMem[i] * totalAssets[i]; // TODO: placeholder, to be removed

    //         // // TODO: compute new deposit requests in shares? Needed for total supply calculation.
    //         // // uint256 newDepositRequests = vault.convertToShares(depositRequests[i]);

    //         // uint256 withdrawalAssets = vault.convertToAssets(withdrawRequests[i]);
    //         // uint256 newTotalAssets = totalAssets[i] + depositRequests[i] - withdrawalAssets + pnlAmount;

    //         // vault.updateVaultState(newTotalAssets);
    //         // slither-disable-end calls-loop
    //     }
    // }
}
