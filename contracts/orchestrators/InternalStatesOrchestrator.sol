// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/IOrionTransparentVault.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import "../interfaces/IOracleRegistry.sol";
import "../interfaces/IInternalStateOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { FHE, euint32 } from "@fhevm/solidity/lib/FHE.sol";

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

    /// @notice Oracle price precision (18 decimals)
    uint256 private constant ORACLE_PRECISION = 1e18;

    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Price hat (p_t) - mapping of token address to estimated price [asset/underlying]
        mapping(address => uint256) priceHat;
        /// @notice Initial batch portfolio (w_0) - mapping of token address to estimated value [assets]
        mapping(address => uint256) initialBatchPortfolioHat;
        /// @notice Final batch portfolio (w_1) - mapping of token address to estimated value [assets]
        mapping(address => uint256) finalBatchPortfolioHat;
        /// @notice Selling orders - mapping of token address to amount that needs to be sold [assets]
        mapping(address => uint256) sellingOrders;
        /// @notice Buying orders - mapping of token address to amount that needs to be bought [assets]
        mapping(address => uint256) buyingOrders;
        /// @notice Array of all tokens used in this epoch for iteration
        address[] tokens;
        /// @notice Mapping to track if a token has been added to avoid duplicates
        mapping(address => bool) tokenExists;
    }

    /// @notice Current epoch state
    EpochState internal _currentEpoch;

    /// @notice Encrypted batch portfolio - mapping of token address to encrypted value [assets]
    mapping(address => euint32) internal _encryptedBatchPortfolio;

    /// @notice Expected underlying sell amount to be able to measure tracking error during sell execution.
    uint256 public expectedUnderlyingSellAmount;

    /// @notice Expected underlying buy amount to be able to compute the tracking error during buy execution.
    uint256 public expectedUnderlyingBuyAmount;

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
        uint256 intentFactor = 10 ** config.curatorIntentDecimals();

        /* ---------- TRANSPARENT VAULTS ---------- */

        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        for (uint256 i = 0; i < transparentVaults.length; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaults[i]);

            (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

            // Calculate estimated active total assets (t_1) and populate batch portfolio
            uint256 t1Hat = 0;
            for (uint256 j = 0; j < portfolioTokens.length; j++) {
                address token = portfolioTokens[j];

                // Get price from cache or from registry.
                // Avoid re-fetching price if already cached.
                uint256 price = _currentEpoch.priceHat[token];
                if (price == 0) {
                    price = registry.getPrice(token);
                    _currentEpoch.priceHat[token] = price;
                }

                // Calculate estimated value of the asset in underlying asset decimals
                uint256 value = _calculateTokenValue(price, sharesPerAsset[j], token);

                t1Hat += value;

                _currentEpoch.initialBatchPortfolioHat[token] += value;
                _addTokenIfNotExists(token);
            }

            uint256 pendingWithdrawalsHat = vault.convertToAssetsWithPITTotalAssets(
                vault.getPendingWithdrawals(),
                t1Hat,
                Math.Rounding.Floor
            );

            // Calculate estimated (active and passive) total assets (t_2), same decimals as underlying.
            uint256 t2Hat = t1Hat + vault.getPendingDeposits() - pendingWithdrawalsHat;

            (address[] memory intentTokens, uint256[] memory intentWeights) = vault.getIntent();

            uint256 intentLength = intentTokens.length;

            for (uint256 j = 0; j < intentLength; j++) {
                address token = intentTokens[j];
                uint256 weight = intentWeights[j];

                // same decimals as underlying
                uint256 value = (t2Hat * weight) / intentFactor;

                _currentEpoch.finalBatchPortfolioHat[token] += value;
                _addTokenIfNotExists(token);
            }
        }

        /* ---------- ENCRYPTED VAULTS ---------- */
        // TODO

        // address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);

        // for (uint256 i = 0; i < encryptedVaults.length; i++) {
        //     IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);

        //     (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();

        //     // Calculate estimated active total assets (t_1) and populate batch portfolio
        //     euint32 encryptedT1Hat = FHE.asEuint32(0);
        //     for (uint256 j = 0; j < portfolioTokens.length; j++) {
        //         address token = portfolioTokens[j];

        //         // Get price from cache or from registry.
        //         // Avoid re-fetching price if already cached.
        //         uint256 price = _currentEpoch.priceHat[token];
        //         if (price == 0) {
        //             price = registry.getPrice(token);
        //             _currentEpoch.priceHat[token] = price;
        //         }

        //         euint32 value = _calculateEncryptedTokenValue(price, sharesPerAsset[j], token);

        //         encryptedT1Hat = FHE.add(encryptedT1Hat, value);

        //         // ...
        //     }

        //     (address[] memory intentTokens, euint32[] memory intentWeights) = vault.getIntent();

        //     // ...
        // }
        // Finally sum up decrypted_encryptedBatchPortfolio to get _finalBatchPortfolioHat
        // Analogous for estimated total assets and for initial batch portfolio.

        // TODO: add reminder portfolio coming from execution error of previous epoch.
        // Store such portfolio in this orchestrator state, write it from the liquidity orchestrator.
        // This also contributes to the current epoch state and is used to estimate the rebalancing orders.

        // Compute selling and buying orders based on portfolio differences
        _computeRebalancingOrders();

        emit EventsLib.InternalStateProcessed(epochCounter);
    }

    /* -------------------------------------------------------------------------- */
    /*                               INTERNAL LOGIC                               */
    /* -------------------------------------------------------------------------- */

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
        // Reset mappings for all tokens used in the previous epoch
        address[] memory tokens = _currentEpoch.tokens;
        uint256 length = tokens.length;

        for (uint256 i = 0; i < length; i++) {
            address token = tokens[i];
            _currentEpoch.priceHat[token] = 0;
            _currentEpoch.initialBatchPortfolioHat[token] = 0;
            _currentEpoch.finalBatchPortfolioHat[token] = 0;
            _currentEpoch.sellingOrders[token] = 0;
            _currentEpoch.buyingOrders[token] = 0;
            _currentEpoch.tokenExists[token] = false;
        }

        // Clear the tokens array
        delete _currentEpoch.tokens;
    }

    /// @notice Adds a token to the current epoch if it doesn't exist
    /// @param token The token address to add
    function _addTokenIfNotExists(address token) internal {
        if (!_currentEpoch.tokenExists[token]) {
            _currentEpoch.tokens.push(token);
            _currentEpoch.tokenExists[token] = true;
        }
    }

    /// @notice Compute selling and buying orders based on portfolio differences
    /// @dev Compares _finalBatchPortfolioHat with _initialBatchPortfolioHat to determine rebalancing needs
    ///      Selling orders are converted from underlying assets to shares for the LiquidityOrchestrator
    ///      Buying orders remain in underlying assets as expected by the LiquidityOrchestrator
    function _computeRebalancingOrders() internal {
        address[] memory tokens = _currentEpoch.tokens;
        uint256 length = tokens.length;

        // Compute expected underlying sell amount to be able to compute the tracking error during sell execution.
        expectedUnderlyingSellAmount = 0;
        expectedUnderlyingBuyAmount = 0;
        for (uint256 i = 0; i < length; i++) {
            address token = tokens[i];
            uint256 initialValue = _currentEpoch.initialBatchPortfolioHat[token];
            uint256 finalValue = _currentEpoch.finalBatchPortfolioHat[token];

            if (initialValue > finalValue) {
                uint256 sellAmountInUnderlying = initialValue - finalValue;

                expectedUnderlyingSellAmount += sellAmountInUnderlying;

                // Convert from underlying assets to shares for LiquidityOrchestrator._executeSell
                // Necessary to compute the number of shares to sell based on oracle price to have consistency with
                // portfolio intent. Alternative, selling underlying-equivalent would lead to a previewWithdraw call
                // or similar, giving a different number of shares.
                uint256 sellAmountInShares = _calculateTokenShares(
                    _currentEpoch.priceHat[token],
                    sellAmountInUnderlying,
                    token
                );
                _currentEpoch.sellingOrders[token] = sellAmountInShares;
            } else if (finalValue > initialValue) {
                uint256 buyAmount = finalValue - initialValue;
                expectedUnderlyingBuyAmount += buyAmount;
                // Keep buying orders in underlying assets as expected by LiquidityOrchestrator._executeBuy
                _currentEpoch.buyingOrders[token] = buyAmount;
            }
            // Else no change, do nothing.
        }
    }

    /// @notice Calculates token value in underlying asset decimals
    /// @dev Handles decimal conversion from token decimals to underlying asset decimals
    ///      Formula: value = (price * shares) / ORACLE_PRECISION * 10^(underlyingDecimals - tokenDecimals)
    ///      This safely handles cases where underlying has more or fewer decimals than the token
    /// @param price The price of the token in underlying asset (18 decimals)
    /// @param shares The amount of token shares (in token decimals)
    /// @param token The token address to get decimals from
    /// @return value The value in underlying asset decimals
    function _calculateTokenValue(uint256 price, uint256 shares, address token) internal view returns (uint256 value) {
        // Calculate base value in shares decimals
        uint256 baseValue = (price * shares) / ORACLE_PRECISION;

        // Get token and underlying decimals
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        uint8 underlyingDecimals = IERC20Metadata(address(config.underlyingAsset())).decimals();

        // Convert to underlying decimals (if else to avoid underflow)
        if (underlyingDecimals >= tokenDecimals) {
            // Scale up: multiply by the difference (underlying has more decimals)
            value = baseValue * (10 ** (underlyingDecimals - tokenDecimals));
        } else {
            // Scale down: divide by the difference (underlying has fewer decimals)
            value = baseValue / (10 ** (tokenDecimals - underlyingDecimals));
        }
    }

    /// @notice Calculates encrypted token value in underlying asset decimals
    /// @dev Handles decimal conversion from token decimals to underlying asset decimals
    ///      Formula: value = (price * shares) / ORACLE_PRECISION * 10^(underlyingDecimals - tokenDecimals)
    ///      This safely handles cases where underlying has more or fewer decimals than the token
    /// @param price The price of the token in underlying asset (18 decimals)
    /// @param shares The encrypted amount of token shares (in token decimals)
    /// @param token The token address to get decimals from
    /// @return value The encrypted value in underlying asset decimals
    function _calculateEncryptedTokenValue(
        uint256 price,
        euint32 shares,
        address token
    ) internal returns (euint32 value) {
        // Calculate base value in shares decimals
        euint32 baseValue = FHE.div(FHE.mul(FHE.asEuint32(uint32(price)), shares), uint32(ORACLE_PRECISION));

        // Get token and underlying decimals
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        uint8 underlyingDecimals = IERC20Metadata(address(config.underlyingAsset())).decimals();

        // Convert to underlying decimals (if else to avoid underflow)
        if (underlyingDecimals >= tokenDecimals) {
            // Scale up: multiply by the difference (underlying has more decimals)
            value = FHE.mul(baseValue, uint32(10 ** (underlyingDecimals - tokenDecimals)));
        } else {
            // Scale down: divide by the difference (underlying has fewer decimals)
            value = FHE.div(baseValue, uint32(10 ** (tokenDecimals - underlyingDecimals)));
        }
    }

    /// @notice Calculates token shares from underlying asset value (inverse of _calculateTokenValue)
    /// @dev Handles decimal conversion from underlying asset decimals to token decimals
    ///      Formula: shares = (value * ORACLE_PRECISION) / (price * 10^(underlyingDecimals - tokenDecimals))
    ///      This safely handles cases where underlying has more or fewer decimals than the token
    /// @param price The price of the token in underlying asset (18 decimals)
    /// @param value The value in underlying asset decimals
    /// @param token The token address to get decimals from
    /// @return shares The amount of token shares (in token decimals)
    function _calculateTokenShares(uint256 price, uint256 value, address token) internal view returns (uint256 shares) {
        // Get token and underlying decimals
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        uint8 underlyingDecimals = IERC20Metadata(address(config.underlyingAsset())).decimals();

        // Convert value from underlying decimals to token decimals scale
        uint256 scaledValue;
        if (underlyingDecimals >= tokenDecimals) {
            // Scale down: divide by the difference (underlying has more decimals)
            scaledValue = value / (10 ** (underlyingDecimals - tokenDecimals));
        } else {
            // Scale up: multiply by the difference (underlying has fewer decimals)
            scaledValue = value * (10 ** (tokenDecimals - underlyingDecimals));
        }

        // Calculate shares: shares = (scaledValue * ORACLE_PRECISION) / price
        shares = (scaledValue * ORACLE_PRECISION) / price;
    }

    /* -------------------------------------------------------------------------- */
    /*                      LIQUIDITY ORCHESTRATOR FUNCTIONS                      */
    /* -------------------------------------------------------------------------- */

    /// @notice Get the selling orders
    /// @return tokens The tokens to sell
    /// @return amounts The amounts to sell in shares (converted from underlying assets)
    function getSellingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory allTokens = _currentEpoch.tokens;
        uint256 allTokensLength = allTokens.length;

        // Count non-zero selling orders
        uint256 count = 0;
        for (uint256 i = 0; i < allTokensLength; i++) {
            if (_currentEpoch.sellingOrders[allTokens[i]] > 0) {
                count++;
            }
        }

        // Create arrays with exact size
        tokens = new address[](count);
        amounts = new uint256[](count);

        // Fill arrays with non-zero values
        uint256 index = 0;
        for (uint256 i = 0; i < allTokensLength; i++) {
            address token = allTokens[i];
            uint256 amount = _currentEpoch.sellingOrders[token];
            if (amount > 0) {
                tokens[index] = token;
                amounts[index] = amount;
                index++;
            }
        }
    }

    /// @notice Get the buying orders
    /// @return tokens The tokens to buy
    /// @return amounts The amounts to buy in underlying assets (as expected by LiquidityOrchestrator)
    function getBuyingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory allTokens = _currentEpoch.tokens;
        uint256 allTokensLength = allTokens.length;

        // Count non-zero buying orders
        uint256 count = 0;
        for (uint256 i = 0; i < allTokensLength; i++) {
            if (_currentEpoch.buyingOrders[allTokens[i]] > 0) {
                count++;
            }
        }

        // Create arrays with exact size
        tokens = new address[](count);
        amounts = new uint256[](count);

        // Fill arrays with non-zero values
        uint256 index = 0;
        for (uint256 i = 0; i < allTokensLength; i++) {
            address token = allTokens[i];
            uint256 amount = _currentEpoch.buyingOrders[token];
            if (amount > 0) {
                tokens[index] = token;
                amounts[index] = amount;
                index++;
            }
        }
    }
}
