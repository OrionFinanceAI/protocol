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
import "../interfaces/ILiquidityOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { UtilitiesLib } from "../libraries/UtilitiesLib.sol";
import { FHE, euint32 } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title Internal States Orchestrator
 * @notice Contract that orchestrates internal state management
 * @author Orion Finance
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

    /// @notice Liquidity Orchestrator contract
    ILiquidityOrchestrator public liquidityOrchestrator;

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

    /// @notice Volume fee coefficient
    uint16 public vFeeCoefficient;
    /// @notice Revenue share fee coefficient
    uint16 public rsFeeCoefficient;

    /// @notice Pending protocol fees [assets]
    uint256 public pendingProtocolFees;

    /// @notice Constants for protocol fee calculations
    uint32 public constant YEAR_IN_SECONDS = 365 days;
    /// @notice Basis points factor
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;
    /// @notice Maximum volume fee (1%)
    uint16 public constant MAX_VOLUME_FEE = 100;
    /// @notice Maximum revenue share fee (15%)
    uint16 public constant MAX_REVENUE_SHARE_FEE = 1_500;

    /// @notice Action constants for checkUpkeep and performUpkeep
    bytes4 private constant ACTION_START = bytes4(keccak256("start()"));
    bytes4 private constant ACTION_PREPROCESS_T_VAULTS = bytes4(keccak256("preprocessTV(uint8)"));
    bytes4 private constant ACTION_PREPROCESS_E_VAULTS = bytes4(keccak256("preprocessEV(uint8)"));
    bytes4 private constant ACTION_BUFFER = bytes4(keccak256("buffer()"));
    bytes4 private constant ACTION_POSTPROCESS_T_VAULTS = bytes4(keccak256("postprocessTV(uint8)"));
    bytes4 private constant ACTION_POSTPROCESS_E_VAULTS = bytes4(keccak256("postprocessEV(uint8)"));
    bytes4 private constant ACTION_BUILD_ORDERS = bytes4(keccak256("buildOrders()"));

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */
    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Mapping of token address to its decimals
        mapping(address => uint8) tokenDecimals;
        /// @notice Price array - mapping of token address to estimated price [shares/assets]
        mapping(address => uint256) priceArray;
        /// @notice Initial batch portfolio - mapping of token address to estimated value [shares]
        mapping(address => uint256) initialBatchPortfolio;
        /// @notice Total assets - mapping of Orion vault address to estimated value [assets]
        mapping(address => uint256) vaultsTotalAssets;
        /// @notice Final batch portfolio - mapping of token address to estimated value [shares]
        mapping(address => uint256) finalBatchPortfolio;
        /// @notice Selling orders - mapping of token address to number of shares that needs to be sold [shares]
        mapping(address => uint256) sellingOrders;
        /// @notice Buying orders - mapping of token address to number of shares that needs to be bought [shares]
        mapping(address => uint256) buyingOrders;
        /// @notice Array of all tokens used in this epoch for iteration
        address[] tokens;
        /// @notice Mapping to track if a token has been added to avoid duplicates
        mapping(address => bool) tokenExists;
    }

    /// @notice Current epoch state
    EpochState internal _currentEpoch;

    /// @notice Encrypted batch portfolio - mapping of token address to encrypted number of shares [shares]
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

    /// @notice Transparent minibatch size
    uint8 public transparentMinibatchSize;
    /// @notice Encrypted minibatch size
    uint8 public encryptedMinibatchSize;

    /// @notice Upkeep phase
    InternalUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice FHE zero
    euint32 internal _ezero;

    /// @notice Transparent vaults associated to the current epoch
    address[] public transparentVaultsEpoch;
    /// @notice Encrypted vaults associated to the current epoch
    address[] public encryptedVaultsEpoch;

    /// @notice Buffer amount [assets]
    uint256 public bufferAmount;

    /// @dev Restricts function to only Chainlink Automation registry
    modifier onlyAutomationRegistry() {
        if (msg.sender != automationRegistry) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only Liquidity Orchestrator
    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor
    /// @param initialOwner The address of the initial owner
    /// @param config_ The address of the OrionConfig contract
    /// @param automationRegistry_ The address of the Chainlink Automation Registry
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
        liquidityOrchestrator = ILiquidityOrchestrator(config.liquidityOrchestrator());

        epochDuration = 1 days;
        _nextUpdateTime = _computeNextUpdateTime(block.timestamp);

        currentPhase = InternalUpkeepPhase.Idle;
        epochCounter = 0;
        currentMinibatchIndex = 0;

        _ezero = FHE.asEuint32(0);
        // slither-disable-next-line unused-return
        FHE.allowThis(_ezero);

        vFeeCoefficient = 0;
        rsFeeCoefficient = 0;

        bufferAmount = 0;
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

    /// @inheritdoc IInternalStateOrchestrator
    function updateProtocolFees(uint16 _vFeeCoefficient, uint16 _rsFeeCoefficient) external onlyOwner {
        if (_vFeeCoefficient > MAX_VOLUME_FEE || _rsFeeCoefficient > MAX_REVENUE_SHARE_FEE)
            revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        vFeeCoefficient = _vFeeCoefficient;
        rsFeeCoefficient = _rsFeeCoefficient;
    }

    /// @notice Checks if upkeep is needed based on time interval
    /// @dev https://docs.chain.link/chainlink-automation/reference/automation-interfaces
    /// @return upkeepNeeded True if upkeep is needed, false otherwise
    /// @return performData Encoded data needed to perform the upkeep
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (config.isSystemIdle() && _shouldTriggerUpkeep()) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_START, uint8(0));
        } else if (currentPhase == InternalUpkeepPhase.PreprocessingTransparentVaults) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_PREPROCESS_T_VAULTS, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.PreprocessingEncryptedVaults) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_PREPROCESS_E_VAULTS, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.Buffering) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_BUFFER, uint8(0));
        } else if (currentPhase == InternalUpkeepPhase.PostprocessingTransparentVaults) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_POSTPROCESS_T_VAULTS, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.PostprocessingEncryptedVaults) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_POSTPROCESS_E_VAULTS, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.BuildingOrders) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_BUILD_ORDERS, uint8(0));
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
    // solhint-disable-next-line code-complexity
    function performUpkeep(bytes calldata performData) external override onlyAutomationRegistry nonReentrant {
        if (performData.length < 4) revert ErrorsLib.InvalidArguments();

        (bytes4 action, uint8 minibatchIndex) = abi.decode(performData, (bytes4, uint8));

        if (action == ACTION_START) {
            _handleStart();
        } else if (action == ACTION_PREPROCESS_T_VAULTS) {
            _preprocessTransparentMinibatch(minibatchIndex);
        } else if (action == ACTION_PREPROCESS_E_VAULTS) {
            _preprocessEncryptedMinibatch(minibatchIndex);
        } else if (action == ACTION_BUFFER) {
            _buffer();
        } else if (action == ACTION_POSTPROCESS_T_VAULTS) {
            _postprocessTransparentMinibatch(minibatchIndex);
        } else if (action == ACTION_POSTPROCESS_E_VAULTS) {
            _postprocessEncryptedMinibatch(minibatchIndex);
        } else if (action == ACTION_BUILD_ORDERS) {
            _buildOrders();
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                               INTERNAL LOGIC                               */
    /* -------------------------------------------------------------------------- */

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
        return block.timestamp > _nextUpdateTime;
    }

    /// @notice Updates the next update time and resets the previous epoch state variables
    function _handleStart() internal {
        // Validate current phase
        if (!_shouldTriggerUpkeep() || !config.isSystemIdle()) revert ErrorsLib.TooEarly();

        _nextUpdateTime = _computeNextUpdateTime(block.timestamp);

        for (uint16 i = 0; i < _currentEpoch.tokens.length; ++i) {
            address token = _currentEpoch.tokens[i];
            delete _currentEpoch.priceArray[token];
            delete _currentEpoch.initialBatchPortfolio[token];
            delete _currentEpoch.vaultsTotalAssets[token];
            delete _currentEpoch.finalBatchPortfolio[token];
            delete _currentEpoch.sellingOrders[token];
            delete _currentEpoch.buyingOrders[token];
            delete _currentEpoch.tokenExists[token];
            delete _currentEpoch.tokenDecimals[token];
        }
        delete _currentEpoch.tokens;

        transparentVaultsEpoch = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        encryptedVaultsEpoch = config.getAllOrionVaults(EventsLib.VaultType.Encrypted);

        currentPhase = InternalUpkeepPhase.PreprocessingTransparentVaults;
    }

    /// @notice Preprocesses minibatch of transparent vaults
    /// @param minibatchIndex The index of the minibatch to process
    function _preprocessTransparentMinibatch(uint8 minibatchIndex) internal {
        // Validate current phase
        if (currentPhase != InternalUpkeepPhase.PreprocessingTransparentVaults) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;

        if (i1 >= transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length);
            // Last minibatch, go to next phase.
            currentPhase = InternalUpkeepPhase.PreprocessingEncryptedVaults;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[i]);

            (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

            // STEP 1: LIVE PORTFOLIO
            uint256 totalAssets = 0;
            for (uint16 j = 0; j < portfolioTokens.length; ++j) {
                address token = portfolioTokens[j];
                uint256 shares = sharesPerAsset[j];

                _currentEpoch.initialBatchPortfolio[token] += shares;

                // Get and cache token decimals and prices if not already cached
                if (!_currentEpoch.tokenExists[token]) {
                    _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();
                    if (token == underlyingAsset) {
                        _currentEpoch.priceArray[token] = 10 ** underlyingDecimals;
                    } else {
                        _currentEpoch.priceArray[token] = registry.getPrice(token);
                    }
                }
                uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];
                uint256 price = _currentEpoch.priceArray[token];

                // Calculate estimated value of the asset in underlying asset decimals
                uint256 value = UtilitiesLib.convertDecimals(
                    price.mulDiv(shares, priceAdapterPrecision),
                    tokenDecimals,
                    underlyingDecimals
                );

                totalAssets += value;
                _addTokenIfNotExists(token);
            }

            // STEP 2: PROTOCOL VOLUME FEE
            uint256 protocolVolumeFee = uint256(vFeeCoefficient).mulDiv(totalAssets, BASIS_POINTS_FACTOR);
            protocolVolumeFee = protocolVolumeFee.mulDiv(epochDuration, YEAR_IN_SECONDS);
            pendingProtocolFees += protocolVolumeFee;
            totalAssets -= protocolVolumeFee;

            // STEP 3 & 4: CURATOR FEES (Management + Performance)
            uint256 curatorFee = vault.curatorFee(totalAssets);
            totalAssets -= curatorFee;

            // Protocol revenue share fee on curator fee
            uint256 protocolRevenueShareFee = uint256(rsFeeCoefficient).mulDiv(curatorFee, BASIS_POINTS_FACTOR);
            pendingProtocolFees += protocolRevenueShareFee;
            curatorFee -= protocolRevenueShareFee;

            // STEP 5: WITHDRAWAL EXCHANGE RATE (based on post-fee totalAssets)
            uint256 pendingWithdrawals = vault.convertToAssetsWithPITTotalAssets(
                vault.pendingRedeem(),
                totalAssets,
                Math.Rounding.Floor
            );

            // STEP 6: DEPOSIT PROCESSING (add deposits, subtract withdrawals)
            totalAssets += vault.pendingDeposit() - pendingWithdrawals;

            _currentEpoch.vaultsTotalAssets[address(vault)] = totalAssets;
        }
    }

    // slither-disable-start reentrancy-no-eth
    // Safe: external calls are view; nonReentrant applied to caller.
    // solhint-disable-next-line code-complexity
    /// @notice Preprocesses minibatch of encrypted vaults
    /// @param minibatchIndex The index of the minibatch to process
    function _preprocessEncryptedMinibatch(uint8 minibatchIndex) internal {
        // Validate current phase
        if (currentPhase != InternalUpkeepPhase.PreprocessingEncryptedVaults) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * encryptedMinibatchSize;
        uint16 i1 = i0 + encryptedMinibatchSize;
        if (i1 >= encryptedVaultsEpoch.length) {
            i1 = uint16(encryptedVaultsEpoch.length);
            // Last minibatch, go to next phase.
            // TODO: integrate Zama callback in performUpkeep logic breakdown
            // (the decryption callback, not the encrypted computation here, updates the phase).
            // TODO: the state is updated in _preprocessEncryptedMinibatch only if there are no encrypted vaults
            // in the minibatch and currentMinibatchIndex == 0.
            currentPhase = InternalUpkeepPhase.Buffering;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            IOrionEncryptedVault vault = IOrionEncryptedVault(encryptedVaultsEpoch[i]);

            // Due to the asynchronous nature of the FHEVM backend, intent submission validation happens in a callback.
            // The decrypted validation result is stored in isIntentValid.
            // The orchestrator checks this flag and skips processing if the intent is invalid.
            if (!vault.isIntentValid()) {
                // Skip processing this vault if intent is invalid
                continue;
            }

            (address[] memory portfolioTokens, euint32[] memory sharesPerAsset) = vault.getPortfolio();

            // STEP 1: LIVE PORTFOLIO
            euint32 totalAssets = _ezero;
            for (uint16 j = 0; j < portfolioTokens.length; ++j) {
                address token = portfolioTokens[j];

                // TODO: manage encrypted initialization at epoch start.
                _encryptedBatchPortfolio[token] = FHE.add(_encryptedBatchPortfolio[token], sharesPerAsset[j]);

                // Get and cache token decimals and prices if not already cached
                if (!_currentEpoch.tokenExists[token]) {
                    _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();
                    if (token == underlyingAsset) {
                        _currentEpoch.priceArray[token] = 10 ** underlyingDecimals;
                    } else {
                        _currentEpoch.priceArray[token] = registry.getPrice(token);
                    }
                }
                // uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];
                // uint256 price = _currentEpoch.priceArray[token];

                // Calculate estimated value of the asset in underlying asset decimals
                euint32 value = _ezero; // TODO implement encrypted generalization for value calculation
                totalAssets = FHE.add(totalAssets, value);
                _addTokenIfNotExists(token);
            }
        }
        // For decryptions of batched portfolio and total assets array,
        // populate list of cyphertexts and then decrypt all together in one call.
        // https://docs.zama.ai/protocol/examples/basic/decryption-in-solidity/fhe-decrypt-multiple-values-in-solidity
    }
    // slither-disable-end reentrancy-no-eth

    // TODO: implement second part (from Step 2) of preprocess logic.
    // Avoid code duplication with transparent equivalent.
    // Because of FHEVM asynchronous nature, we need another transaction to perform computations on the
    // decrypted array of total assets to compute fees and store plaintext initial batch portfolio state.

    /**
     * @notice Updates the protocol buffer to maintain solvency and capital efficiency
     * @dev In general, this function implements a stochastic optimal control framework for buffer management
     *      that balances critical objectives and acts as a clearing house for market impact.
     *
     *      1. **Solvency Constraint:** The buffer must remain non-negative at all times to ensure
     *         protocol solvency.
     *
     *      2. **Capital Efficiency:** The buffer size should be minimized relative to Total Value
     *         Locked (TVL) to reduce capital inefficiency.
     *
     *      **Buffer Management Strategy:**
     *      - Calculates the total protocol assets across all vaults (transparent and encrypted)
     *      - Determines the target buffer amount based on the configured target ratio
     *      - Only increases the buffer if current buffer is below target (no buffer reduction)
     *      - Distributes the buffer cost proportionally across all vaults
     */
    function _buffer() internal {
        // Validate current phase
        if (currentPhase != InternalUpkeepPhase.Buffering) {
            revert ErrorsLib.InvalidState();
        }
        currentPhase = InternalUpkeepPhase.PostprocessingTransparentVaults;

        uint256 protocolTotalAssets = 0;
        for (uint16 i = 0; i < transparentVaultsEpoch.length; ++i) {
            address vault = transparentVaultsEpoch[i];
            protocolTotalAssets += _currentEpoch.vaultsTotalAssets[address(vault)];
        }
        for (uint16 i = 0; i < encryptedVaultsEpoch.length; ++i) {
            address vault = encryptedVaultsEpoch[i];
            protocolTotalAssets += _currentEpoch.vaultsTotalAssets[address(vault)];
        }

        uint256 targetBufferAmount = protocolTotalAssets.mulDiv(
            liquidityOrchestrator.targetBufferRatio(),
            BASIS_POINTS_FACTOR
        );

        // Only increase buffer if current buffer is below target (conservative approach)
        if (bufferAmount > targetBufferAmount) return;

        uint256 deltaBufferAmount = targetBufferAmount - bufferAmount;
        for (uint16 i = 0; i < transparentVaultsEpoch.length; ++i) {
            address vault = transparentVaultsEpoch[i];
            uint256 vaultAssets = _currentEpoch.vaultsTotalAssets[address(vault)];
            uint256 vaultBufferCost = deltaBufferAmount.mulDiv(vaultAssets, protocolTotalAssets);
            _currentEpoch.vaultsTotalAssets[address(vault)] -= vaultBufferCost;
        }
        for (uint16 i = 0; i < encryptedVaultsEpoch.length; ++i) {
            address vault = encryptedVaultsEpoch[i];
            uint256 vaultAssets = _currentEpoch.vaultsTotalAssets[address(vault)];
            uint256 vaultBufferCost = deltaBufferAmount.mulDiv(vaultAssets, protocolTotalAssets);
            _currentEpoch.vaultsTotalAssets[address(vault)] -= vaultBufferCost;
        }
        bufferAmount += deltaBufferAmount;
    }

    /// @notice Postprocesses minibatch of transparent vaults
    /// @param minibatchIndex The index of the minibatch to postprocess
    function _postprocessTransparentMinibatch(uint8 minibatchIndex) internal {
        // Validate current phase
        if (currentPhase != InternalUpkeepPhase.PostprocessingTransparentVaults) {
            revert ErrorsLib.InvalidState();
        }
        // TODO: a lot of logic in common with preprocess logic, refactor.

        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;

        if (i1 >= transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length);
            // Last minibatch, go to next phase.
            currentPhase = InternalUpkeepPhase.PostprocessingEncryptedVaults;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[i]);

            (address[] memory intentTokens, uint32[] memory intentWeights) = vault.getIntent();
            uint256 finalTotalAssets = _currentEpoch.vaultsTotalAssets[address(vault)];

            for (uint16 j = 0; j < intentTokens.length; ++j) {
                address token = intentTokens[j];
                uint32 weight = intentWeights[j];

                // Get and cache token decimals and prices if not already cached
                if (!_currentEpoch.tokenExists[token]) {
                    _currentEpoch.tokenDecimals[token] = IERC20Metadata(token).decimals();

                    if (token == underlyingAsset) {
                        _currentEpoch.priceArray[token] = 10 ** underlyingDecimals;
                    } else {
                        _currentEpoch.priceArray[token] = registry.getPrice(token);
                    }
                }
                uint8 tokenDecimals = _currentEpoch.tokenDecimals[token];
                uint256 price = _currentEpoch.priceArray[token];

                uint256 value = UtilitiesLib.convertDecimals(
                    finalTotalAssets.mulDiv(weight, intentFactor).mulDiv(priceAdapterPrecision, price),
                    underlyingDecimals,
                    tokenDecimals
                );

                _currentEpoch.finalBatchPortfolio[token] += value;
                _addTokenIfNotExists(token);
            }
        }
    }

    /// @notice Postprocesses minibatch of encrypted vaults
    /// @param minibatchIndex The index of the minibatch to postprocess
    function _postprocessEncryptedMinibatch(uint8 minibatchIndex) internal {
        // Validate current phase
        if (currentPhase != InternalUpkeepPhase.PostprocessingEncryptedVaults) {
            revert ErrorsLib.InvalidState();
        }
        // TODO: implement postprocess logic. Avoid code duplication with transparent equivalent.
        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * encryptedMinibatchSize;
        uint16 i1 = i0 + encryptedMinibatchSize;
        if (i1 >= encryptedVaultsEpoch.length) {
            i1 = uint16(encryptedVaultsEpoch.length);
            // Last minibatch, go to next phase.
            // TODO: integrate Zama callback in performUpkeep logic breakdown
            // (the decryption callback, not the encrypted computation here, updates the phase).
            // TODO: the state is updated in _preprocessEncryptedMinibatch only if there are no encrypted vaults
            // in the minibatch and currentMinibatchIndex == 0.
            currentPhase = InternalUpkeepPhase.BuildingOrders;
            currentMinibatchIndex = 0;
        }
    }

    /// @notice Adds a token to the current epoch if it doesn't exist
    /// @param token The token address to add
    function _addTokenIfNotExists(address token) internal {
        if (!_currentEpoch.tokenExists[token]) {
            _currentEpoch.tokens.push(token);
            _currentEpoch.tokenExists[token] = true;
        }
    }

    /// @notice Builds selling and buying orders based on portfolio differences
    /// @dev Compares _finalBatchPortfolio with _initialBatchPortfolio to determine rebalancing needs
    ///      Orders are stored in _currentEpoch.sellingOrders and _currentEpoch.buyingOrders.
    function _buildOrders() internal {
        // Validate current phase
        if (currentPhase != InternalUpkeepPhase.BuildingOrders) {
            revert ErrorsLib.InvalidState();
        }
        address[] memory tokens = _currentEpoch.tokens;
        uint16 length = uint16(tokens.length);

        for (uint16 i = 0; i < length; ++i) {
            address token = tokens[i];
            uint256 initialValue = _currentEpoch.initialBatchPortfolio[token];
            uint256 finalValue = _currentEpoch.finalBatchPortfolio[token];

            if (initialValue > finalValue) {
                _currentEpoch.sellingOrders[token] = initialValue - finalValue;
            } else if (finalValue > initialValue) {
                _currentEpoch.buyingOrders[token] = finalValue - initialValue;
            }
        }

        currentPhase = InternalUpkeepPhase.Idle;
        ++epochCounter;
        emit EventsLib.InternalStateProcessed(epochCounter);
    }

    /* -------------------------------------------------------------------------- */
    /*                      LIQUIDITY ORCHESTRATOR FUNCTIONS                      */
    /* -------------------------------------------------------------------------- */

    // TODO: coalesce both getOrders functions into one, accepting an order type as an argument.

    /// @inheritdoc IInternalStateOrchestrator
    function getSellingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory allTokens = _currentEpoch.tokens;
        uint16 allTokensLength = uint16(allTokens.length);

        tokens = new address[](allTokensLength);
        amounts = new uint256[](allTokensLength);

        for (uint16 i = 0; i < allTokensLength; ++i) {
            address token = allTokens[i];
            tokens[i] = token;
            amounts[i] = _currentEpoch.sellingOrders[token];
        }
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getBuyingOrders() external view returns (address[] memory tokens, uint256[] memory amounts) {
        address[] memory allTokens = _currentEpoch.tokens;
        uint16 allTokensLength = uint16(allTokens.length);

        tokens = new address[](allTokensLength);
        amounts = new uint256[](allTokensLength);

        for (uint16 i = 0; i < allTokensLength; ++i) {
            address token = allTokens[i];
            tokens[i] = token;
            amounts[i] = _currentEpoch.buyingOrders[token];
        }
    }

    /// @inheritdoc IInternalStateOrchestrator
    function subtractPendingProtocolFees(uint256 amount) external onlyLiquidityOrchestrator {
        if (amount > pendingProtocolFees) revert ErrorsLib.InsufficientAmount();
        pendingProtocolFees -= amount;
    }
}
