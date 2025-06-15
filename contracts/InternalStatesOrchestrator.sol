// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

// https://automation.chain.link/
// InternalStatesOrchestrator: Orchestrates internal state transitions triggered by Chainlink Automation
contract InternalStatesOrchestrator is Ownable2Step, AutomationCompatibleInterface {
    /// @notice Timestamp when the next upkeep is allowed
    uint256 public nextUpdateTime;

    /// @notice Interval in seconds between upkeeps
    uint256 public constant UPDATE_INTERVAL = 1 minutes;

    /// @notice Chainlink Automation Registry address
    address public immutable registry;

    /// @notice Emitted when internal states are processed
    event InternalStateProcessed(uint256 timestamp);

    /// @param _registry The Chainlink Automation registry address
    constructor(address _registry) Ownable(msg.sender) {
        registry = _registry;
        nextUpdateTime = block.timestamp + UPDATE_INTERVAL;
    }

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyRegistry() {
        require(msg.sender == registry, "Not Chainlink Registry");
        _;
    }

    /// @notice Called off-chain by Chainlink nodes to check if `performUpkeep()` should be called
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        upkeepNeeded = block.timestamp >= nextUpdateTime;
        performData = bytes("");
        return (upkeepNeeded, performData);
    }

    /// @notice Called by Chainlink Automation to execute internal state logic
    function performUpkeep(bytes calldata) external override onlyRegistry {
        require(block.timestamp >= nextUpdateTime, "Too early");

        _processInternalStates();

        // Update the timestamp for the next run
        nextUpdateTime = block.timestamp + UPDATE_INTERVAL;
    }

    function _processInternalStates() internal {
        // TODO:
        // 1. Collect states from all Orion vaults and from price oracle

        // 2. Update internal states based on the collected states
        // TVL_t+1= TVL_t + Deposits - Withdraw + P&L(vault)
        // share_price_t+1 = share_price + P&L(vault)

        // 3. Trigger Liquidity Orchestrator to update liquidity positions based on updated internal states.

        emit InternalStateProcessed(block.timestamp);
    }
}
