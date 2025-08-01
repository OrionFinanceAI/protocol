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
    /* -------------------------------------------------------------------------- */
    /*                                 CONTRACTS                                  */
    /* -------------------------------------------------------------------------- */
    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Oracle Registry contract
    IOracleRegistry public registry;

    /* -------------------------------------------------------------------------- */
    /*                                 CONSTANTS                                  */
    /* -------------------------------------------------------------------------- */
    /// @notice Oracle price precision (18 decimals)
    uint256 private constant ORACLE_PRECISION = 1e18;

    /// @notice Intent factor for calculations
    uint256 public intentFactor;

    /// @notice Decimals of the underlying asset
    uint8 public underlyingDecimals;

    /// @notice Action constants for checkUpkeep and performUpkeep
    bytes4 private constant ACTION_START = bytes4(keccak256("start()"));
    bytes4 private constant ACTION_PROCESS_TRANSPARENT_VAULT = bytes4(keccak256("processTransparentVault(uint256)"));
    bytes4 private constant ACTION_PROCESS_ENCRYPTED_VAULTS = bytes4(keccak256("processEncryptedVaults()"));
    bytes4 private constant ACTION_AGGREGATE = bytes4(keccak256("aggregate()"));

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */
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
        /// @notice Mapping of token address to its decimals
        mapping(address => uint8) tokenDecimals;
    }

    /// @notice Current epoch state
    EpochState internal _currentEpoch;

    /// @notice Encrypted batch portfolio - mapping of token address to encrypted value [assets]
    mapping(address => euint32) internal _encryptedBatchPortfolio;

    /// @notice Expected underlying sell amount to be able to measure tracking error during sell execution.
    uint256 public expectedUnderlyingSellAmount;

    /// @notice Expected underlying buy amount to be able to compute the tracking error during buy execution.
    uint256 public expectedUnderlyingBuyAmount;

    /* -------------------------------------------------------------------------- */
    /*                               UPKEEP STATE                                 */
    /* -------------------------------------------------------------------------- */
    /// @notice Upkeep phase
    enum UpkeepPhase {
        Idle,
        ProcessingTransparentVaults,
        ProcessingEncryptedVaults,
        Aggregating
    }
    // TODO: protect against adding/removing vaults when UpkeepPhase != Idle. Same for the Liquidity Orchestrator
    // Same for adding/removing whitelisted assets. Potentially others.
    // Some protocol interactions need to be disabled when the rebalancing is in progres.
    // Reblancing is in progress if at least one orchestrator is not idle.

    /// @notice Counter for tracking processing cycles
    uint256 public epochCounter;
    /// @notice Timestamp when the next upkeep is allowed
    uint256 public nextUpdateTime;
    /// @notice Epoch duration
    uint256 public constant updateInterval = 1 minutes;

    /// @notice Upkeep phase
    UpkeepPhase public currentPhase;
    /// @notice Current vault index
    uint256 public currentVaultIndex;
    /// @notice Transparent vaults associated to the current epoch
    address[] public transparentVaultsEpoch;

    function initialize(address initialOwner, address automationRegistry_, address config_) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();

        automationRegistry = automationRegistry_;
        config = IOrionConfig(config_);

        registry = IOracleRegistry(config.oracleRegistry());
        intentFactor = 10 ** config.curatorIntentDecimals();
        underlyingDecimals = IERC20Metadata(address(config.underlyingAsset())).decimals();

        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
        epochCounter = 0;

        currentPhase = UpkeepPhase.Idle;
        currentVaultIndex = 0;
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
    /// @dev https://docs.chain.link/chainlink-automation/reference/automation-interfaces
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (currentPhase == UpkeepPhase.Idle && _shouldTriggerUpkeep()) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_START);
        } else if (
            currentPhase == UpkeepPhase.ProcessingTransparentVaults && currentVaultIndex < transparentVaultsEpoch.length
        ) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_PROCESS_TRANSPARENT_VAULT, currentVaultIndex);
        } else if (currentPhase == UpkeepPhase.ProcessingEncryptedVaults) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_PROCESS_ENCRYPTED_VAULTS);
        } else if (currentPhase == UpkeepPhase.Aggregating) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_AGGREGATE);
        } else {
            upkeepNeeded = false;
            performData = "";
        }
    }

    /// @notice Performs state reading and estimation operations
    /// @dev This function:
    ///      - Reads current vault states and oracle prices;
    ///      - Computes estimated system states;
    ///      - Updates epoch state to trigger the Liquidity Orchestrator
    function performUpkeep(bytes calldata performData) external override onlyAutomationRegistry nonReentrant {
        if (performData.length < 4) revert ErrorsLib.InvalidArguments();

        bytes4 action = bytes4(performData[:4]);

        if (action == ACTION_START) {
            _checkAndCountEpoch();
            _resetEpochState();
            transparentVaultsEpoch = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
            currentVaultIndex = 0;
            currentPhase = UpkeepPhase.ProcessingTransparentVaults;
        } else if (action == ACTION_PROCESS_TRANSPARENT_VAULT) {
            uint256 index = abi.decode(performData[4:], (uint256));
            _processTransparentVault(index);
        } else if (action == ACTION_PROCESS_ENCRYPTED_VAULTS) {
            _processEncryptedVaults();
        } else if (action == ACTION_AGGREGATE) {
            // TODO: Finally sum up decrypted_encryptedBatchPortfolio to get _finalBatchPortfolioHat
            // TODO: same for estimated total assets and for initial batch portfolio.

            // Compute selling and buying orders based on portfolio differences
            _computeRebalancingOrders();

            currentPhase = UpkeepPhase.Idle;
            delete transparentVaultsEpoch;
            epochCounter++;
            emit EventsLib.InternalStateProcessed(epochCounter);
        } else {
            revert ErrorsLib.InvalidArguments();
        }
    }

    /// @notice Processes a transparent vault
    /// @param index The index of the transparent vault to process
    function _processTransparentVault(uint256 index) internal {
        IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[index]);

        (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

        // Calculate estimated active total assets (t_1) and populate batch portfolio
        uint256 t1Hat = 0;
        for (uint256 j = 0; j < portfolioTokens.length; j++) {
            address token = portfolioTokens[j];

            // Get and cache token decimals if not already cached
            if (_currentEpoch.tokenDecimals[token] == 0) {
                _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();
            }
            uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];

            // Get and cache price if not already cached
            uint256 price = _currentEpoch.priceHat[token];
            if (price == 0) {
                price = registry.getPrice(token);
                _currentEpoch.priceHat[token] = price;
            }

            // Calculate estimated value of the asset in underlying asset decimals
            uint256 value = _calculateTokenValue(price, sharesPerAsset[j], tokenDecimals);
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
        // TODO: - curator_fee(TVL, return, ...) - protocol_fee(vault)

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

        currentVaultIndex++;

        if (currentVaultIndex >= transparentVaultsEpoch.length) {
            currentPhase = UpkeepPhase.ProcessingEncryptedVaults;
        }
    }

    /// @notice Processes encrypted vaults
    function _processEncryptedVaults() internal {
        address[] memory encryptedVaults = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);

        for (uint256 i = 0; i < encryptedVaults.length; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaults[i]);
            (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();

            // Calculate estimated active total assets (t_1) and populate batch portfolio
            euint32 encryptedT1Hat = FHE.asEuint32(0);
            for (uint256 j = 0; j < portfolioTokens.length; j++) {
                address token = portfolioTokens[j];

                // Get and cache token decimals if not already cached
                if (_currentEpoch.tokenDecimals[token] == 0) {
                    _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();
                }
                uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];

                // Get and cache price if not already cached
                uint256 price = _currentEpoch.priceHat[token];
                if (price == 0) {
                    price = registry.getPrice(token);
                    _currentEpoch.priceHat[token] = price;
                }

                euint32 value = _calculateEncryptedTokenValue(price, sharesPerAsset[j], tokenDecimals);
                encryptedT1Hat = FHE.add(encryptedT1Hat, value);
                // TODO...
            }
            (address[] memory intentTokens, euint32[] memory intentWeights) = vault.getIntent();
            // TODO...

            // TODO: curator fee(TVL, return,...) - protocol fee(vault).
            // Protocol fee here can be different from the transparent vaults because of added costs.
        }

        currentPhase = UpkeepPhase.Aggregating;
    }

    /* -------------------------------------------------------------------------- */
    /*                               INTERNAL LOGIC                               */
    /* -------------------------------------------------------------------------- */

    /// @notice Checks if upkeep should be triggered based on time
    /// @dev If upkeep should be triggered, updates the next update time
    function _checkAndCountEpoch() internal {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();
        nextUpdateTime = _computeNextUpdateTime(block.timestamp);
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
            delete _currentEpoch.priceHat[token];
            delete _currentEpoch.initialBatchPortfolioHat[token];
            delete _currentEpoch.finalBatchPortfolioHat[token];
            delete _currentEpoch.sellingOrders[token];
            delete _currentEpoch.buyingOrders[token];
            delete _currentEpoch.tokenExists[token];
            delete _currentEpoch.tokenDecimals[token];
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
            uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];

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
                    tokenDecimals
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

    /// @notice Helper function to convert value between token decimals and underlying asset decimals
    /// @param amount The amount to convert
    /// @param fromDecimals The decimals of the original amount
    /// @param toDecimals The decimals to convert to
    /// @return scaledAmount The amount converted to the target decimals
    function _convertDecimals(
        uint256 amount,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256 scaledAmount) {
        if (toDecimals > fromDecimals) {
            // Scale up: multiply by the difference
            scaledAmount = amount * (10 ** (toDecimals - fromDecimals));
        } else if (toDecimals < fromDecimals) {
            // Scale down: divide by the difference
            scaledAmount = amount / (10 ** (fromDecimals - toDecimals));
        } else {
            // No conversion needed if decimals are the same
            scaledAmount = amount;
        }
    }

    /// @notice Calculates token value in underlying asset decimals
    /// @dev Handles decimal conversion from token decimals to underlying asset decimals
    ///      Formula: value = (price * shares) / ORACLE_PRECISION * 10^(underlyingDecimals - tokenDecimals)
    ///      This safely handles cases where underlying has more or fewer decimals than the token
    /// @param price The price of the token in underlying asset (18 decimals)
    /// @param shares The amount of token shares (in token decimals)
    /// @param tokenDecimals The decimals of the token
    /// @return value The value in underlying asset decimals
    function _calculateTokenValue(
        uint256 price,
        uint256 shares,
        uint8 tokenDecimals
    ) internal view returns (uint256 value) {
        uint256 baseValue = price * shares;
        uint256 scaledValue = _convertDecimals(baseValue, tokenDecimals, underlyingDecimals);
        value = scaledValue / ORACLE_PRECISION;
    }

    /// @notice Calculates encrypted token value in underlying asset decimals
    /// @dev Same as _calculateTokenValue but with encrypted shares
    function _calculateEncryptedTokenValue(
        uint256 price,
        euint32 shares,
        uint8 tokenDecimals
    ) internal view returns (euint32 value) {
        // TODO...
    }

    /// @notice Calculates token shares from underlying asset value (inverse of _calculateTokenValue)
    /// @dev Handles decimal conversion from underlying asset decimals to token decimals
    ///      Formula: shares = (value * ORACLE_PRECISION) / (price * 10^(underlyingDecimals - tokenDecimals))
    ///      This safely handles cases where underlying has more or fewer decimals than the token
    /// @param price The price of the token in underlying asset (18 decimals)
    /// @param value The value in underlying asset decimals
    /// @param tokenDecimals The decimals of the token
    /// @return shares The amount of token shares (in token decimals)
    function _calculateTokenShares(
        uint256 price,
        uint256 value,
        uint8 tokenDecimals
    ) internal view returns (uint256 shares) {
        uint256 scaledValue = _convertDecimals(value, underlyingDecimals, tokenDecimals);
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
