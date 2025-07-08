// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/IOrionTransparentVault.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import "../interfaces/IOracleRegistry.sol";
import "../interfaces/IInternalStateOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

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

    /// @notice Price hat (p_t) - mapping of token address to estimated price [USD]
    EnumerableMap.AddressToUintMap internal _priceHat;

    /// @notice Initial batch portfolio (w_0) - mapping of token address to estimated value [assets]
    EnumerableMap.AddressToUintMap internal _initialBatchPortfolioHat;

    /// @notice Final batch portfolio (w_1) - mapping of token address to estimated value [assets]
    EnumerableMap.AddressToUintMap internal _finalBatchPortfolioHat;

    /// @notice Selling orders - mapping of token address to amount that needs to be sold [assets]
    EnumerableMap.AddressToUintMap internal _sellingOrders;

    /// @notice Buying orders - mapping of token address to amount that needs to be bought [assets]
    EnumerableMap.AddressToUintMap internal _buyingOrders;

    /// @notice Encrypted batch portfolio - mapping of token address to encrypted value [assets]
    mapping(address => euint32) internal _encryptedBatchPortfolio;

    function initialize(address initialOwner, address automationRegistry_, address config_) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();

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
        if (newConfig == address(0)) revert ErrorsLib.ZeroAddress();
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
        _checkAndCountEpoch();
        _resetEpochState();

        IOracleRegistry registry = IOracleRegistry(config.oracleRegistry());

        // Transparent Vaults

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

                // Get price from cache or from registry.
                // Avoid re-fetching price if already cached.
                uint256 price;
                (bool priceExists, uint256 cachedPrice) = _priceHat.tryGet(token);
                if (priceExists) {
                    price = cachedPrice;
                } else {
                    price = registry.getPrice(token);
                    // slither-disable-next-line unused-return
                    _priceHat.set(token, price);
                }

                // Calculate estimated value of the asset.
                uint256 value = price * sharesPerAsset[j];

                t1Hat += value;

                (bool initialValueExists, uint256 currentValue) = _initialBatchPortfolioHat.tryGet(token);
                if (initialValueExists) {
                    // slither-disable-next-line unused-return
                    _initialBatchPortfolioHat.set(token, currentValue + value);
                } else {
                    // slither-disable-next-line unused-return
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
                uint256 value = (t2Hat * weight) / (10 ** config.curatorIntentDecimals());

                (bool finalValueExists, uint256 currentValue) = _finalBatchPortfolioHat.tryGet(token);
                if (finalValueExists) {
                    // slither-disable-next-line unused-return
                    _finalBatchPortfolioHat.set(token, currentValue + value);
                } else {
                    // slither-disable-next-line unused-return
                    _finalBatchPortfolioHat.set(token, value);
                }
            }
        }

        // Encrypted Vaults

        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);
        length = encryptedVaults.length;
        for (uint256 i = 0; i < length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);

            (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();
            (address[] memory intentTokens, euint32[] memory intentWeights) = vault.getIntent();
            // TODO: add entry point for Zama coprocessor for both dot product and batching operations.
            // encrypted batched portfolio to be summed up in Zama coprocessor and then added to the two batchPortfolio.
            // _encryptedBatchPortfolio
        }
        // TODO: finally sum up _encryptedBatchPortfolio to get _finalBatchPortfolioHat
        // Analogous for estimated total assets.

        // Compute selling and buying orders based on portfolio differences
        _computeRebalancingOrders();

        emit EventsLib.InternalStateProcessed(epochCounter);
    }

    /* -------------------------------------------------------------------------- */
    /*                               INTERNAL LOGIC                               */
    /* -------------------------------------------------------------------------- */

    /// -------- 1. housekeeping --------------------------------------------------
    function _checkAndCountEpoch() internal {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
        epochCounter++;
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

    /// @notice Resets the previous epoch state variables
    function _resetEpochState() internal {
        _priceHat.clear();
        _initialBatchPortfolioHat.clear();
        _finalBatchPortfolioHat.clear();
        _sellingOrders.clear();
        _buyingOrders.clear();
    }

    /// @notice Compute selling and buying orders based on portfolio differences
    /// @dev Compares _finalBatchPortfolioHat with _initialBatchPortfolioHat to determine rebalancing needs
    function _computeRebalancingOrders() internal {
        uint256 initialLength = _initialBatchPortfolioHat.length();

        for (uint256 i = 0; i < initialLength; i++) {
            (address token, uint256 initialValue) = _initialBatchPortfolioHat.at(i);
            (bool finalValueExists, uint256 finalValue) = _finalBatchPortfolioHat.tryGet(token);

            if (!finalValueExists) {
                // If token is not in final portfolio, it means it needs to be sold fully.
                // slither-disable-next-line unused-return
                _sellingOrders.set(token, initialValue);
                continue;
            }

            // If token is in final portfolio, check if it needs to be sold or bought.
            if (initialValue > finalValue) {
                uint256 sellAmount = initialValue - finalValue;
                // slither-disable-next-line unused-return
                _sellingOrders.set(token, sellAmount);
            } else if (finalValue > initialValue) {
                uint256 buyAmount = finalValue - initialValue;
                // slither-disable-next-line unused-return
                _buyingOrders.set(token, buyAmount);
            }
        }

        uint256 finalLength = _finalBatchPortfolioHat.length();
        for (uint256 i = 0; i < finalLength; i++) {
            (address token, uint256 finalValue) = _finalBatchPortfolioHat.at(i);
            // slither-disable-next-line unused-return
            (bool initialValueExists, ) = _initialBatchPortfolioHat.tryGet(token);

            if (!initialValueExists) {
                // If token is not in initial portfolio, it means it needs to be bought fully.
                // slither-disable-next-line unused-return
                _buyingOrders.set(token, finalValue);
            }
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                      LIQUIDITY ORCHESTRATOR FUNCTIONS                      */
    /* -------------------------------------------------------------------------- */

    /// @notice Get the selling orders
    /// @return tokens The tokens to sell
    /// @return amounts The amounts to sell
    function getSellingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 length = _sellingOrders.length();
        tokens = new address[](length);
        amounts = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            (address key, uint256 value) = _sellingOrders.at(i);
            tokens[i] = key;
            amounts[i] = value;
        }
    }

    /// @notice Get the buying orders
    /// @return tokens The tokens to buy
    /// @return amounts The amounts to buy
    function getBuyingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 length = _buyingOrders.length();
        tokens = new address[](length);
        amounts = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            (address key, uint256 value) = _buyingOrders.at(i);
            tokens[i] = key;
            amounts[i] = value;
        }
    }
}
