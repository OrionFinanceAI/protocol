// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IMarketOracle.sol";

/// @title Internal States Orchestrator
/// @notice Orchestrates internal state transitions triggered by Chainlink Automation
/// @dev This contract manages periodic updates of vault states and market data through Chainlink Automation
contract InternalStatesOrchestrator is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    AutomationCompatibleInterface
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

    function initialize(address initialOwner, address _registry, address _config) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        registry = _registry;
        config = IOrionConfig(_config);

        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyRegistry() {
        require(msg.sender == registry, "Not Chainlink Registry");
        _;
    }

    function updateRegistry(address _newRegistry) external onlyOwner {
        registry = _newRegistry;
    }

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
    function performUpkeep(bytes calldata) external override onlyRegistry {
        require(_shouldTriggerUpkeep(), "Too early");

        // 1. Collect states from market oracle
        IMarketOracle oracle = config.marketOracle();
        // TODO: break down following function to have a read-only query
        // and another which is actually writing to the oracle state latest price.
        (uint256[] memory previousPriceArray, uint256[] memory currentPriceArray) = oracle.getPrices();

        // 2. Collect states from all Orion vaults
        uint256 vaultCount = config.orionVaultsLength();

        for (uint256 i = 0; i < vaultCount; i++) {
            address vaultAddress = config.getOrionVaultAt(i);
            IOrionVault vault = IOrionVault(vaultAddress);

            // Read vault states
            uint256 sharePrice = vault.sharePrice();
            uint256 totalAssets = vault.totalAssets();
        }

        // 3. Update internal states based on the collected states
        // TVL_t+1= TVL_t + Deposits - Withdraw + P&L(vault)
        // share_price_t+1 = share_price + P&L(vault)

        emit InternalStateProcessed(block.timestamp);

        // TODO: consider having another offchain process
        // (potentially again chainlink automation) listening to this event
        // and updating the liquidity positions in another transaction.
        // No atomicity, but better for scalability. To be discussed.
        // 4. Trigger Liquidity Orchestrator to update liquidity positions based on updated internal states.
        // TODO: Implement liquidity orchestrator trigger

        // Update the timestamp for the next run
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
    }

    function _shouldTriggerUpkeep() internal view returns (bool) {
        return block.timestamp >= nextUpdateTime;
    }

    function _computeNextUpdateTime(uint256 currentTime) internal pure returns (uint256) {
        return currentTime + UPDATE_INTERVAL;
    }
}
