// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/IOrionTransparentVault.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import "../interfaces/IPriceAdapterRegistry.sol";
import "../interfaces/IInternalStateOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { UtilitiesLib } from "../libraries/UtilitiesLib.sol";
import { FHE, euint32 } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title Internal States Orchestrator
 * @notice Orchestrates state reading and estimation operations triggered by Chainlink Automation
 * @dev This contract is responsible for:
 *      - Reading current vault states and market data;
 *      - Computing state estimations for Liquidity Orchestrator;
 *      - Trigger the Liquidity Orchestrator.
 *
 *      This contract does NOT execute transactions or write vault states.
 *      It only performs read operations and calculations to estimate state changes.
 *      Actual state modifications and transaction execution are handled by the Liquidity Orchestrator contract.
 */
contract InternalStatesOrchestrator is SepoliaConfig, Ownable, ReentrancyGuard, IInternalStateOrchestrator {
    using Math for uint256;

    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Price Adapter Registry contract
    IPriceAdapterRegistry public registry;

    /// @notice Price Adapter Precision
    uint256 public priceAdapterPrecision;

    /// @notice Intent factor for calculations
    uint256 public intentFactor;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice Decimals of the underlying asset
    uint8 public underlyingDecimals;

    /// @notice Action constants for checkUpkeep and performUpkeep
    bytes4 private constant ACTION_START = bytes4(keccak256("start()"));
    bytes4 private constant ACTION_PROCESS_TRANSPARENT_VAULT = bytes4(keccak256("processTransparentVault(uint8)"));
    bytes4 private constant ACTION_PROCESS_ENCRYPTED_VAULTS = bytes4(keccak256("processEncryptedVaults(uint8)"));
    bytes4 private constant ACTION_AGGREGATE = bytes4(keccak256("aggregate()"));

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */
    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Price array (p_t) - mapping of token address to estimated price [asset/underlying]
        mapping(address => uint256) priceArray;
        /// @notice Initial batch portfolio (w_0) - mapping of token address to estimated value [assets]
        mapping(address => uint256) initialBatchPortfolio;
        /// @notice Final batch portfolio (w_1) - mapping of token address to estimated value [assets]
        mapping(address => uint256) finalBatchPortfolio;
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

    /* -------------------------------------------------------------------------- */
    /*                               UPKEEP STATE                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Epoch duration
    uint32 public epochDuration;
    /// @notice Timestamp when the next upkeep is allowed
    uint256 private _nextUpdateTime;
    /// @notice Counter for tracking processing cycles
    uint16 public epochCounter;

    /// @notice Minibatch sizes
    uint8 public transparentMinibatchSize;
    uint8 public encryptedMinibatchSize;

    /// @notice Upkeep phase
    InternalUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice FHE zero
    euint32 internal _ezero;

    /// @notice Vaults associated to the current epoch
    address[] public transparentVaultsEpoch;
    address[] public encryptedVaultsEpoch;

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyAutomationRegistry() {
        if (msg.sender != automationRegistry) revert ErrorsLib.NotAuthorized();
        _;
    }

    constructor(
        address initialOwner,
        address config_,
        address automationRegistry_
    ) Ownable(initialOwner) ReentrancyGuard() {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(config_);
        registry = IPriceAdapterRegistry(config.priceAdapterRegistry());
        intentFactor = 10 ** config.curatorIntentDecimals();
        underlyingAsset = address(config.underlyingAsset());
        underlyingDecimals = IERC20Metadata(underlyingAsset).decimals();
        priceAdapterPrecision = 10 ** config.priceAdapterDecimals();
        transparentMinibatchSize = 1;
        encryptedMinibatchSize = 1;

        automationRegistry = automationRegistry_;

        epochDuration = 1 days;
        _nextUpdateTime = _computeNextUpdateTime(block.timestamp);

        currentPhase = InternalUpkeepPhase.Idle;
        epochCounter = 0;
        currentMinibatchIndex = 0;

        _ezero = FHE.asEuint32(0);
    }

    /// @inheritdoc IInternalStateOrchestrator
    function updateAutomationRegistry(address newAutomationRegistry) external onlyOwner {
        if (newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        automationRegistry = newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(newAutomationRegistry);
    }

    /// @inheritdoc IInternalStateOrchestrator
    function updateEpochDuration(uint32 newEpochDuration) external onlyOwner {
        if (newEpochDuration == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        epochDuration = newEpochDuration;
    }

    /// @inheritdoc IInternalStateOrchestrator
    function updateMinibatchSizes(uint8 _transparentMinibatchSize, uint8 _encryptedMinibatchSize) external onlyOwner {
        if (_transparentMinibatchSize == 0 || _encryptedMinibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        transparentMinibatchSize = _transparentMinibatchSize;
        encryptedMinibatchSize = _encryptedMinibatchSize;
    }

    /// @notice Checks if upkeep is needed based on time interval
    /// @dev https://docs.chain.link/chainlink-automation/reference/automation-interfaces
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (config.isSystemIdle() && _shouldTriggerUpkeep()) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_START);
        } else if (currentPhase == InternalUpkeepPhase.ProcessingTransparentVaults) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_PROCESS_TRANSPARENT_VAULT, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.ProcessingEncryptedVaults) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_PROCESS_ENCRYPTED_VAULTS, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.Aggregating) {
            upkeepNeeded = true;
            performData = abi.encodePacked(ACTION_AGGREGATE);
        } else {
            upkeepNeeded = false;
            performData = "";
        }
    }

    /// @notice Performs state reading and estimation operations
    /// @dev This function:
    ///      - Reads current vault states and adapter prices;
    ///      - Computes estimated system states;
    ///      - Updates epoch state to trigger the Liquidity Orchestrator
    function performUpkeep(bytes calldata performData) external override onlyAutomationRegistry nonReentrant {
        if (performData.length < 4) revert ErrorsLib.InvalidArguments();

        bytes4 action = bytes4(performData[:4]);

        if (action == ACTION_START) {
            _checkAndCountEpoch();
            _resetEpochState();

            transparentVaultsEpoch = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
            encryptedVaultsEpoch = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);

            currentPhase = InternalUpkeepPhase.ProcessingTransparentVaults;
        } else if (action == ACTION_PROCESS_TRANSPARENT_VAULT) {
            uint8 minibatchIndex = abi.decode(performData[4:], (uint8));
            _processTransparentMinibatch(minibatchIndex);
        } else if (action == ACTION_PROCESS_ENCRYPTED_VAULTS) {
            uint8 minibatchIndex = abi.decode(performData[4:], (uint8));
            _processEncryptedMinibatch(minibatchIndex);
        } else if (action == ACTION_AGGREGATE) {
            // Compute selling and buying orders based on portfolio differences
            _computeRebalancingOrders();

            currentPhase = InternalUpkeepPhase.Idle;
            epochCounter++;
            emit EventsLib.InternalStateProcessed(epochCounter);
        } else {
            revert ErrorsLib.InvalidArguments();
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                               INTERNAL LOGIC                               */
    /* -------------------------------------------------------------------------- */

    /// @notice Processes minibatch of transparent vaults
    /// @param minibatchIndex The index of the minibatch to process
    function _processTransparentMinibatch(uint8 minibatchIndex) internal {
        currentMinibatchIndex++;

        uint16 i0 = minibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;
        if (i1 > transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length);
            // Last minibatch, go to encrypted vaults phase next.
            currentPhase = InternalUpkeepPhase.ProcessingEncryptedVaults;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; i++) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[i]);

            (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

            // Calculate estimated active total assets (t_1) and populate batch portfolio
            uint256 activeTotalAssets = 0;

            for (uint16 j = 0; j < portfolioTokens.length; j++) {
                address token = portfolioTokens[j];

                // Get and cache token decimals if not already cached
                if (_currentEpoch.tokenDecimals[token] == 0) {
                    _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();
                }
                uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];

                // Get and cache price if not already cached
                uint256 price = _currentEpoch.priceArray[token];
                if (price == 0) {
                    if (token == underlyingAsset) {
                        price = 10 ** underlyingDecimals;
                    } else {
                        price = registry.getPrice(token);
                    }
                    _currentEpoch.priceArray[token] = price;
                }

                // Calculate estimated value of the asset in underlying asset decimals
                uint256 value = UtilitiesLib.convertDecimals(
                    price.mulDiv(sharesPerAsset[j], priceAdapterPrecision),
                    tokenDecimals,
                    underlyingDecimals
                );

                activeTotalAssets += value;
                _currentEpoch.initialBatchPortfolio[token] += value;
                _addTokenIfNotExists(token);
            }

            uint256 pendingWithdrawals = vault.convertToAssetsWithPITTotalAssets(
                vault.getPendingWithdrawals(),
                activeTotalAssets,
                Math.Rounding.Floor
            );

            // Calculate estimated total assets (active and passive, including curator and protocol fees),
            // same decimals as underlying.
            uint256 predictedTotalAssets = activeTotalAssets +
                vault.getPendingDeposits() -
                pendingWithdrawals -
                vault.curatorFee(activeTotalAssets);
            // TODO - protocol_fee(vault)
            // TODO; open issue to solve, how to distribute protocol fee to multiple vaults and a common buffer amount.

            (address[] memory intentTokens, uint32[] memory intentWeights) = vault.getIntent();
            uint16 intentLength = uint16(intentTokens.length);
            for (uint16 j = 0; j < intentLength; j++) {
                address token = intentTokens[j];
                uint32 weight = intentWeights[j];

                // same decimals as underlying
                uint256 value = predictedTotalAssets.mulDiv(weight, intentFactor);

                _currentEpoch.finalBatchPortfolio[token] += value;
                _addTokenIfNotExists(token);
            }
        }
    }

    /// @notice Processes minibatch of encrypted vaults
    // slither-disable-start reentrancy-no-eth
    // Safe: external calls are view; nonReentrant applied to caller.
    function _processEncryptedMinibatch(uint8 minibatchIndex) internal nonReentrant {
        currentMinibatchIndex++;

        uint16 i0 = minibatchIndex * encryptedMinibatchSize;
        uint16 i1 = i0 + encryptedMinibatchSize;
        if (i1 > encryptedVaultsEpoch.length) {
            i1 = uint16(encryptedVaultsEpoch.length);
            // Last minibatch, go to aggregating phase next.
            currentPhase = InternalUpkeepPhase.Aggregating;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; i++) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaultsEpoch[i]);

            // Due to the asynchronous nature of the FHEVM backend, intent submission validation happens in a callback.
            // The decrypted validation result is stored in isIntentValid.
            // The orchestrator checks this flag and skips processing if the intent is invalid.
            if (!vault.isIntentValid()) {
                // Skip processing this vault if intent is invalid
                continue;
            }

            (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();

            // Calculate estimated active total assets (t_1) and populate batch portfolio
            // euint32 encryptedActiveTotalAssets = _ezero;

            for (uint16 j = 0; j < portfolioTokens.length; j++) {
                address token = portfolioTokens[j];

                // Get and cache token decimals if not already cached
                if (_currentEpoch.tokenDecimals[token] == 0) {
                    _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();
                }
                // uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];

                // Get and cache price if not already cached
                uint256 price = _currentEpoch.priceArray[token];
                if (price == 0) {
                    if (token == underlyingAsset) {
                        price = 10 ** underlyingDecimals;
                    } else {
                        price = registry.getPrice(token);
                    }
                    _currentEpoch.priceArray[token] = price;
                }

                // TODO implement encrypted generalization for value calculation
                // euint32 value = ...
                // encryptedActiveTotalAssets = FHE.add(encryptedActiveTotalAssets, value);
            }
            // (address[] memory intentTokens, euint32[] memory intentWeights) = vault.getIntent();
            // TODO...
            // TODO: Protocol fee here can be different from the transparent
            // vaults because of added infra costs, consider if fair.
        }
        // TODO: for decryptions, populate list of cyphertexts and then decrypt all together in one call.
        // https://docs.zama.ai/protocol/examples/basic/decryption-in-solidity/fhe-decrypt-multiple-values-in-solidity

        // TODO: decrypt minibatch and incrementally add to initialBatchPortfolio, finalBatchPortfolio.

        // TODO: same for estimated total assets.
    }
    // slither-disable-end reentrancy-no-eth

    // TODO: once _processEncryptedMinibatch populated:
    // a lot of code duplication in _processEncryptedMinibatch and _processTransparentMinibatch,
    // refactor.

    /// @notice Checks if upkeep should be triggered based on time
    /// @dev If upkeep should be triggered, updates the next update time
    function _checkAndCountEpoch() internal {
        if (!_shouldTriggerUpkeep()) revert ErrorsLib.TooEarly();
        _nextUpdateTime = _computeNextUpdateTime(block.timestamp);
    }

    /// @notice Computes the next update time based on current timestamp
    /// @param currentTime Current block timestamp
    /// @return Next update time
    function _computeNextUpdateTime(uint256 currentTime) internal view returns (uint256) {
        return currentTime + epochDuration;
    }

    /// @notice Checks if upkeep should be triggered based on time
    /// @return True if upkeep should be triggered
    function _shouldTriggerUpkeep() internal view returns (bool) {
        // slither-disable-next-line timestamp
        return block.timestamp >= _nextUpdateTime;
    }

    /// @notice Resets the previous epoch state variables
    function _resetEpochState() internal {
        // Reset mappings for all tokens used in the previous epoch
        address[] memory tokens = _currentEpoch.tokens;
        uint16 length = uint16(tokens.length);

        for (uint16 i = 0; i < length; i++) {
            address token = tokens[i];
            delete _currentEpoch.priceArray[token];
            delete _currentEpoch.initialBatchPortfolio[token];
            delete _currentEpoch.finalBatchPortfolio[token];
            delete _currentEpoch.sellingOrders[token];
            delete _currentEpoch.buyingOrders[token];
            delete _currentEpoch.tokenExists[token];
            delete _currentEpoch.tokenDecimals[token];
        }

        // Clear the tokens array
        delete _currentEpoch.tokens;

        // Clear the vaults arrays
        delete transparentVaultsEpoch;
        delete encryptedVaultsEpoch;
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
    /// @dev Compares _finalBatchPortfolio with _initialBatchPortfolio to determine rebalancing needs
    ///      Selling orders are converted from underlying assets to shares for the LiquidityOrchestrator
    ///      Buying orders remain in underlying assets as expected by the LiquidityOrchestrator
    function _computeRebalancingOrders() internal {
        address[] memory tokens = _currentEpoch.tokens;
        uint16 length = uint16(tokens.length);

        for (uint16 i = 0; i < length; i++) {
            address token = tokens[i];
            uint256 initialValue = _currentEpoch.initialBatchPortfolio[token];
            uint256 finalValue = _currentEpoch.finalBatchPortfolio[token];
            uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];

            if (initialValue > finalValue) {
                uint256 sellAmountInUnderlying = initialValue - finalValue;

                // Convert from underlying assets to shares for LiquidityOrchestrator._executeSell
                // Necessary to compute the number of shares to sell based on adapter price to have consistency with
                // portfolio intent. Alternative, selling underlying-equivalent would lead to a previewWithdraw call
                // or similar, giving a different number of shares.
                uint256 sellAmountInShares = _calculateTokenShares(
                    _currentEpoch.priceArray[token],
                    sellAmountInUnderlying,
                    tokenDecimals
                );
                _currentEpoch.sellingOrders[token] = sellAmountInShares;
            } else if (finalValue > initialValue) {
                uint256 buyAmount = finalValue - initialValue;
                // Keep buying orders in underlying assets as expected by LiquidityOrchestrator._executeBuy
                _currentEpoch.buyingOrders[token] = buyAmount;
            }
            // Else no change, do nothing.
        }
    }

    // TODO: docs inconsistency with implementation, check and fix.
    /// @notice Calculates token shares from underlying asset value (inverse of _calculateTokenValue)
    /// @dev Handles decimal conversion from underlying asset decimals to token decimals
    ///      Formula: shares = (value * priceAdapterDecimals) / (price * 10^(underlyingDecimals - tokenDecimals))
    ///      This safely handles cases where underlying has more or fewer decimals than the token
    /// @param price The price of the token in underlying asset (priceAdapterDecimals decimals)
    /// @param value The value in underlying asset decimals
    /// @param tokenDecimals The decimals of the token
    /// @return shares The amount of token shares (in token decimals)
    function _calculateTokenShares(
        uint256 price,
        uint256 value,
        uint8 tokenDecimals
    ) internal view returns (uint256 shares) {
        uint256 scaledValue = UtilitiesLib.convertDecimals(value, underlyingDecimals, tokenDecimals);
        shares = scaledValue.mulDiv(priceAdapterPrecision, price);
    }

    /* -------------------------------------------------------------------------- */
    /*                      LIQUIDITY ORCHESTRATOR FUNCTIONS                      */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc IInternalStateOrchestrator
    function getSellingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory allTokens = _currentEpoch.tokens;
        uint16 allTokensLength = uint16(allTokens.length);

        // Count non-zero selling orders
        uint16 count = 0;
        for (uint16 i = 0; i < allTokensLength; i++) {
            if (_currentEpoch.sellingOrders[allTokens[i]] > 0) {
                count++;
            }
        }

        // Create arrays with exact size
        tokens = new address[](count);
        amounts = new uint256[](count);

        // Fill arrays with non-zero values
        uint16 index = 0;
        for (uint16 i = 0; i < allTokensLength; i++) {
            address token = allTokens[i];
            uint256 amount = _currentEpoch.sellingOrders[token];
            if (amount > 0) {
                tokens[index] = token;
                amounts[index] = amount;
                index++;
            }
        }
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getBuyingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory allTokens = _currentEpoch.tokens;
        uint16 allTokensLength = uint16(allTokens.length);

        // Count non-zero buying orders
        uint16 count = 0;
        for (uint16 i = 0; i < allTokensLength; i++) {
            if (_currentEpoch.buyingOrders[allTokens[i]] > 0) {
                count++;
            }
        }

        // Create arrays with exact size
        tokens = new address[](count);
        amounts = new uint256[](count);

        // Fill arrays with non-zero values
        uint16 index = 0;
        for (uint16 i = 0; i < allTokensLength; i++) {
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
