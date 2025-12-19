// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../interfaces/IOrionTransparentVault.sol";
import "../interfaces/IPriceAdapterRegistry.sol";
import "../interfaces/IInternalStateOrchestrator.sol";
import "../interfaces/ILiquidityOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";
import { UtilitiesLib } from "../libraries/UtilitiesLib.sol";

/**
 * @title Internal States Orchestrator
 * @notice Contract that orchestrates internal state management
 * @author Orion Finance
 * @dev This contract is responsible for:
 *      - Reading current vault states and market data;
 *      - Processing curator fees and high water mark;
 *      - Updating vault states;
 *      - Computing state estimations for Liquidity Orchestrator;
 *      - Trigger the Liquidity Orchestrator.
 * @custom:security-contact security@orionfinance.ai
 */
contract InternalStatesOrchestrator is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IInternalStateOrchestrator
{
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

    /// @notice Timestamp when new protocol fee rates become effective
    uint256 public newProtocolFeeRatesTimestamp;

    /// @notice Old volume fee coefficient (used during cooldown period)
    uint16 private oldVFeeCoefficient;
    /// @notice Old revenue share fee coefficient (used during cooldown period)
    uint16 private oldRsFeeCoefficient;

    /// @notice Pending protocol fees [assets]
    uint256 public pendingProtocolFees;

    /// @notice Basis points factor
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;
    /// @notice Maximum transparent minibatch size
    uint8 public constant MAX_TRANSPARENT_MINIBATCH_SIZE = 8;
    /// @notice Maximum epoch duration (2 weeks = 14 days)
    uint32 public constant MAX_EPOCH_DURATION = 14 days;

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */
    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Array of all tokens used in this epoch for iteration
        address[] tokens;
        /// @notice Mapping to track if a token has been added to avoid duplicates
        mapping(address => bool) tokenExists;
        /// @notice Price array - token address to estimated price [shares/assets]
        mapping(address => uint256) priceArray;
        /// @notice Total assets - Orion vault address to estimated value [assets]
        mapping(address => uint256) vaultsTotalAssets;
        /// @notice Total assets for fulfill redeem - vault address to total assets for fulfillRedeem [assets]
        mapping(address => uint256) vaultsTotalAssetsForFulfillRedeem;
        /// @notice Total assets for fulfill deposit - vault address to total assets for fulfillDeposit [assets]
        mapping(address => uint256) vaultsTotalAssetsForFulfillDeposit;
        /// @notice Array of tokens in each vault's portfolio
        mapping(address => address[]) vaultPortfolioTokens;
        /// @notice Array of shares for each vault's portfolio (parallel to vaultPortfolioTokens) [shares]
        mapping(address => uint256[]) vaultPortfolioShares;
        /// @notice Initial batch portfolio - token address to estimated value [shares]
        mapping(address => uint256) initialBatchPortfolio;
        /// @notice Final batch portfolio - token address to estimated value [shares]
        mapping(address => uint256) finalBatchPortfolio;
        /// @notice Selling orders - token address to number of shares that needs to be sold [shares]
        mapping(address => uint256) sellingOrders;
        /// @notice Buying orders - token address to number of shares that needs to be bought [shares]
        mapping(address => uint256) buyingOrders;
    }

    /// @notice Current epoch state
    EpochState internal _currentEpoch;

    /* -------------------------------------------------------------------------- */
    /*                               UPKEEP STATE                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Epoch duration
    uint32 public epochDuration;
    /// @notice Timestamp when the next upkeep is allowed
    uint256 private _nextUpdateTime;

    /// @notice Transparent minibatch size
    uint8 public transparentMinibatchSize;

    /// @notice Upkeep phase
    InternalUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice Transparent vaults associated to the current epoch
    address[] public transparentVaultsEpoch;

    /// @notice Buffer amount [assets]
    uint256 public bufferAmount;

    /// @notice Flag to determine if LP processing should be performed
    bool public processLP;

    /// @dev Restricts function to only owner or automation registry
    modifier onlyAuthorizedTrigger() {
        if (msg.sender != owner() && msg.sender != automationRegistry) {
            revert ErrorsLib.NotAuthorized();
        }
        _;
    }

    /// @dev Restricts function to only Orion Config contract
    modifier onlyConfig() {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @dev Restricts function to only Liquidity Orchestrator
    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract
    /// @param initialOwner The address of the initial owner
    /// @param config_ The address of the OrionConfig contract
    /// @param automationRegistry_ The address of the Chainlink Automation Registry
    function initialize(address initialOwner, address config_, address automationRegistry_) public initializer {
        if (initialOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        config = IOrionConfig(config_);
        registry = IPriceAdapterRegistry(config.priceAdapterRegistry());
        intentFactor = 10 ** config.curatorIntentDecimals();
        underlyingAsset = address(config.underlyingAsset());
        underlyingDecimals = config.getTokenDecimals(underlyingAsset);
        priceAdapterPrecision = 10 ** config.priceAdapterDecimals();
        transparentMinibatchSize = 1;

        automationRegistry = automationRegistry_;
        liquidityOrchestrator = ILiquidityOrchestrator(config.liquidityOrchestrator());

        epochDuration = 1 days;
        _nextUpdateTime = block.timestamp + epochDuration;

        currentPhase = InternalUpkeepPhase.Idle;
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
        if (newEpochDuration > MAX_EPOCH_DURATION) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        epochDuration = newEpochDuration;
        _nextUpdateTime = Math.min(block.timestamp + epochDuration, _nextUpdateTime);
    }

    /// @inheritdoc IInternalStateOrchestrator
    function updateMinibatchSize(uint8 _transparentMinibatchSize) external onlyOwner {
        if (_transparentMinibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (_transparentMinibatchSize > MAX_TRANSPARENT_MINIBATCH_SIZE) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        transparentMinibatchSize = _transparentMinibatchSize;
    }

    /// @inheritdoc IInternalStateOrchestrator
    function updateProtocolFees(uint16 _vFeeCoefficient, uint16 _rsFeeCoefficient) external onlyOwner {
        /// Maximum volume fee: 0.5%
        /// Maximum revenue share fee: 20%
        if (_vFeeCoefficient > 50 || _rsFeeCoefficient > 2_000) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Store old fees for cooldown period
        (uint16 oldVFee, uint16 oldRsFee) = activeProtocolFees();
        oldVFeeCoefficient = oldVFee;
        oldRsFeeCoefficient = oldRsFee;

        // Update to new fees immediately in storage
        vFeeCoefficient = _vFeeCoefficient;
        rsFeeCoefficient = _rsFeeCoefficient;

        // Set when new rates become effective
        newProtocolFeeRatesTimestamp = block.timestamp + config.feeChangeCooldownDuration();

        emit EventsLib.ProtocolFeeChangeScheduled(_vFeeCoefficient, _rsFeeCoefficient);
    }

    /// @notice Returns the active protocol fees (old during cooldown, new after)
    /// @return vFee The active volume fee coefficient
    /// @return rsFee The active revenue share fee coefficient
    function activeProtocolFees() public view returns (uint16 vFee, uint16 rsFee) {
        // If we're still in cooldown period, return old rates
        if (newProtocolFeeRatesTimestamp > block.timestamp) {
            return (oldVFeeCoefficient, oldRsFeeCoefficient);
        }
        // Otherwise return new rates
        return (vFeeCoefficient, rsFeeCoefficient);
    }

    /// @inheritdoc IInternalStateOrchestrator
    function resetPhase(InternalUpkeepPhase targetPhase) external onlyOwner {
        ILiquidityOrchestrator.LiquidityUpkeepPhase loPhase = liquidityOrchestrator.currentPhase();

        // Validate target phase based on LO phase
        if (targetPhase == InternalUpkeepPhase.PreprocessingTransparentVaults) {
            if (loPhase == ILiquidityOrchestrator.LiquidityUpkeepPhase.SellingLeg) {
                _handleStart();
            }
        } else if (targetPhase == InternalUpkeepPhase.PostprocessingTransparentVaults) {
            if (
                loPhase == ILiquidityOrchestrator.LiquidityUpkeepPhase.SellingLeg ||
                loPhase == ILiquidityOrchestrator.LiquidityUpkeepPhase.BuyingLeg
            ) {
                currentPhase = InternalUpkeepPhase.PostprocessingTransparentVaults;
                currentMinibatchIndex = 0;
            }
        }
    }

    /* solhint-disable code-complexity */
    /// @notice Checks if upkeep is needed based on time interval
    /// @dev https://docs.chain.link/chainlink-automation/reference/automation-interfaces
    /// @return upkeepNeeded True if upkeep is needed, false otherwise
    /// @return performData Empty bytes
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        if (config.isSystemIdle() && _shouldTriggerUpkeep()) {
            upkeepNeeded = true;
        } else if (currentPhase == InternalUpkeepPhase.PreprocessingTransparentVaults) {
            upkeepNeeded = true;
        } else if (currentPhase == InternalUpkeepPhase.Buffering) {
            upkeepNeeded = true;
        } else if (currentPhase == InternalUpkeepPhase.PostprocessingTransparentVaults) {
            upkeepNeeded = true;
        } else if (currentPhase == InternalUpkeepPhase.BuildingOrders) {
            upkeepNeeded = true;
        } else {
            upkeepNeeded = false;
        }
        performData = "";
    }

    /// @notice Performs state reading and estimation operations
    /// @dev Can be called statelessly (in any phase).
    ///      Payload format: abi.encode(bool processLP, address[] excludedAssets)
    ///      - processLP: used only by preprocessing
    ///      - excludedAssets: used only by postprocessing
    function performUpkeep(
        bytes calldata performData
    ) external override onlyAuthorizedTrigger nonReentrant whenNotPaused {
        bool newProcessLP = true;
        address[] memory excludedAssets = new address[](0);
        if (performData.length > 0) {
            (newProcessLP, excludedAssets) = abi.decode(performData, (bool, address[]));
        }
        processLP = newProcessLP;

        if (config.isSystemIdle() && _shouldTriggerUpkeep()) {
            _handleStart();
        } else if (currentPhase == InternalUpkeepPhase.PreprocessingTransparentVaults) {
            _preprocessTransparentMinibatch();
        } else if (currentPhase == InternalUpkeepPhase.Buffering) {
            _buffer();
        } else if (currentPhase == InternalUpkeepPhase.PostprocessingTransparentVaults) {
            _postprocessTransparentMinibatch(excludedAssets);
        } else if (currentPhase == InternalUpkeepPhase.BuildingOrders) {
            _buildOrders();

            currentPhase = InternalUpkeepPhase.Idle;
            liquidityOrchestrator.advanceIdlePhase();
        }
    }
    /* solhint-enable code-complexity */

    /* -------------------------------------------------------------------------- */
    /*                               INTERNAL LOGIC                               */
    /* -------------------------------------------------------------------------- */

    /// @notice Checks if upkeep should be triggered based on time
    /// @return True if upkeep should be triggered
    function _shouldTriggerUpkeep() internal view returns (bool) {
        // slither-disable-next-line timestamp
        return block.timestamp > _nextUpdateTime;
    }

    /// @notice Build filtered transparent vaults list for the epoch
    function _buildTransparentVaultsEpoch() internal {
        address[] memory allTransparent = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        delete transparentVaultsEpoch;

        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        for (uint16 i = 0; i < allTransparent.length; ++i) {
            address v = allTransparent[i];
            if (IOrionVault(v).pendingDeposit(maxFulfillBatchSize) + IOrionVault(v).totalAssets() == 0) continue;
            transparentVaultsEpoch.push(v);
        }
    }

    /// @notice Updates the next update time and resets the previous epoch state variables
    function _handleStart() internal {
        // Save previous epoch's vault list before clearing to properly reset vault-specific mappings
        address[] memory previousEpochVaults = new address[](transparentVaultsEpoch.length);
        for (uint16 i = 0; i < transparentVaultsEpoch.length; ++i) {
            previousEpochVaults[i] = transparentVaultsEpoch[i];
        }

        // Clear token-specific mappings
        for (uint16 i = 0; i < _currentEpoch.tokens.length; ++i) {
            address token = _currentEpoch.tokens[i];
            delete _currentEpoch.priceArray[token];
            delete _currentEpoch.tokenExists[token];

            delete _currentEpoch.initialBatchPortfolio[token];
            delete _currentEpoch.finalBatchPortfolio[token];
            delete _currentEpoch.sellingOrders[token];
            delete _currentEpoch.buyingOrders[token];
        }

        // Clear vault-specific mappings
        for (uint16 i = 0; i < previousEpochVaults.length; ++i) {
            address vault = previousEpochVaults[i];
            delete _currentEpoch.vaultsTotalAssets[vault];
            delete _currentEpoch.vaultsTotalAssetsForFulfillRedeem[vault];
            delete _currentEpoch.vaultsTotalAssetsForFulfillDeposit[vault];

            delete _currentEpoch.vaultPortfolioTokens[vault];
            delete _currentEpoch.vaultPortfolioShares[vault];
        }
        delete _currentEpoch.tokens;

        // Build filtered vault lists for this epoch
        _buildTransparentVaultsEpoch();

        if (transparentVaultsEpoch.length > 0) {
            currentPhase = InternalUpkeepPhase.PreprocessingTransparentVaults;
            currentMinibatchIndex = 0;
        }
    }

    // slither-disable-start reentrancy-no-eth

    /// @notice Preprocesses minibatch of transparent vaults
    function _preprocessTransparentMinibatch() internal {
        uint16 i0 = currentMinibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;
        ++currentMinibatchIndex;
        if (i1 > transparentVaultsEpoch.length || i1 == transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length);
            currentPhase = InternalUpkeepPhase.Buffering;
            currentMinibatchIndex = 0;
        }

        (uint16 activeVFee, uint16 activeRsFee) = activeProtocolFees();
        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();

        for (uint16 i = i0; i < i1; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[i]);

            (address[] memory portfolioTokens, uint256[] memory sharesPerAsset) = vault.getPortfolio();

            // STEP 1: LIVE PORTFOLIO
            uint256 totalAssets = 0;
            for (uint16 j = 0; j < portfolioTokens.length; ++j) {
                address token = portfolioTokens[j];
                uint256 shares = sharesPerAsset[j];

                _currentEpoch.initialBatchPortfolio[token] += shares;

                // Get and cache prices if not already cached
                if (!_currentEpoch.tokenExists[token]) {
                    if (token == underlyingAsset) {
                        _currentEpoch.priceArray[token] = UtilitiesLib.convertDecimals(
                            10 ** underlyingDecimals,
                            underlyingDecimals,
                            config.priceAdapterDecimals()
                        );
                    } else {
                        _currentEpoch.priceArray[token] = registry.getPrice(token);
                    }
                }
                uint256 price = _currentEpoch.priceArray[token];

                // Calculate estimated value of the asset in underlying asset decimals
                uint256 value = UtilitiesLib.convertDecimals(
                    price.mulDiv(shares, priceAdapterPrecision),
                    config.getTokenDecimals(token),
                    underlyingDecimals
                );

                totalAssets += value;
                _addTokenIfNotExists(token);
            }

            // STEP 2: PROTOCOL VOLUME FEE
            uint256 protocolVolumeFee = uint256(activeVFee).mulDiv(totalAssets, BASIS_POINTS_FACTOR);
            protocolVolumeFee = protocolVolumeFee.mulDiv(epochDuration, 365 days);
            pendingProtocolFees += protocolVolumeFee;
            totalAssets -= protocolVolumeFee;

            // STEP 3 & 4: CURATOR FEES (Management + Performance)
            uint256 curatorFee = vault.curatorFee(totalAssets);

            totalAssets -= curatorFee;
            _currentEpoch.vaultsTotalAssetsForFulfillRedeem[address(vault)] = totalAssets;

            uint256 protocolRevenueShareFee = uint256(activeRsFee).mulDiv(curatorFee, BASIS_POINTS_FACTOR);
            pendingProtocolFees += protocolRevenueShareFee;
            curatorFee -= protocolRevenueShareFee;
            vault.accrueCuratorFees(curatorFee);

            if (processLP) {
                // STEP 5: WITHDRAWAL EXCHANGE RATE (based on post-fee totalAssets)
                uint256 pendingRedeem = vault.convertToAssetsWithPITTotalAssets(
                    vault.pendingRedeem(maxFulfillBatchSize),
                    totalAssets,
                    Math.Rounding.Floor
                );

                // STEP 6: DEPOSIT PROCESSING (add deposits, subtract withdrawals)
                totalAssets -= pendingRedeem;
                uint256 pendingDeposit = vault.pendingDeposit(maxFulfillBatchSize);
                _currentEpoch.vaultsTotalAssetsForFulfillDeposit[address(vault)] = totalAssets;
                totalAssets += pendingDeposit;
            }
            _currentEpoch.vaultsTotalAssets[address(vault)] = totalAssets;
        }
    }

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
        currentPhase = InternalUpkeepPhase.PostprocessingTransparentVaults;

        uint16 nTransparentVaults = uint16(transparentVaultsEpoch.length);

        uint256 protocolTotalAssets = 0;
        for (uint16 i = 0; i < nTransparentVaults; ++i) {
            address vault = transparentVaultsEpoch[i];
            protocolTotalAssets += _currentEpoch.vaultsTotalAssets[address(vault)];
        }

        uint256 targetBufferAmount = protocolTotalAssets.mulDiv(
            liquidityOrchestrator.targetBufferRatio(),
            BASIS_POINTS_FACTOR
        );

        // Only increase buffer if current buffer is below target (conservative approach)
        if (bufferAmount > targetBufferAmount) return;

        uint256 deltaBufferAmount = targetBufferAmount - bufferAmount;
        uint256 actualBufferAllocated = 0;
        for (uint16 i = 0; i < nTransparentVaults; ++i) {
            address vault = transparentVaultsEpoch[i];
            uint256 vaultAssets = _currentEpoch.vaultsTotalAssets[address(vault)];
            uint256 vaultBufferCost = deltaBufferAmount.mulDiv(vaultAssets, protocolTotalAssets);
            _currentEpoch.vaultsTotalAssets[address(vault)] -= vaultBufferCost;
            actualBufferAllocated += vaultBufferCost;
        }
        // Update bufferAmount with actual allocated amount to avoid rounding drift
        bufferAmount += actualBufferAllocated;
    }

    /// @notice Postprocesses minibatch of transparent vaults
    /// @param excludedAssets List of assets to exclude from processing
    function _postprocessTransparentMinibatch(address[] memory excludedAssets) internal {
        uint16 i0 = currentMinibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;
        ++currentMinibatchIndex;

        if (i1 > transparentVaultsEpoch.length || i1 == transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length); // Last minibatch, go to next phase.
            currentPhase = InternalUpkeepPhase.BuildingOrders;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[i]);
            address vaultAddress = address(vault);

            (address[] memory intentTokens, uint32[] memory intentWeights) = vault.getIntent();
            uint256 finalTotalAssets = _currentEpoch.vaultsTotalAssets[vaultAddress];

            // TODO: use excludedAssets to reinterpret intentTokens and
            // intentWeights maintaining accounting correctness, also based on current
            // LO phase read here, forcing the value of the excluded asset to be th same as the initial (no trades).
            // Based on the phase, the reinterpretation of the intent is different.
            // LiquidityOrchestrator is selling: this means we are underleveraged by the amount we cannot sell,
            // (totalAssets - illiquidPosition(s)) * intent / sumActiveIntentWeights
            // LiquidityOrchestrator is buying: this means we have extra underlying asset in the portfolio.
            // Important: this has to be performed per vault,
            // and direction of batched trade != direction of single trades.

            for (uint16 j = 0; j < intentTokens.length; ++j) {
                address token = intentTokens[j];
                uint32 weight = intentWeights[j];
                if (!_currentEpoch.tokenExists[token]) {
                    if (token == underlyingAsset) {
                        _currentEpoch.priceArray[token] = UtilitiesLib.convertDecimals(
                            10 ** underlyingDecimals,
                            underlyingDecimals,
                            config.priceAdapterDecimals()
                        );
                    } else {
                        _currentEpoch.priceArray[token] = registry.getPrice(token);
                    }
                }
                uint256 price = _currentEpoch.priceArray[token];
                uint256 value = UtilitiesLib.convertDecimals(
                    finalTotalAssets.mulDiv(weight, intentFactor).mulDiv(priceAdapterPrecision, price),
                    underlyingDecimals,
                    config.getTokenDecimals(token)
                );

                _currentEpoch.vaultPortfolioTokens[vaultAddress].push(token);
                _currentEpoch.vaultPortfolioShares[vaultAddress].push(value);

                _currentEpoch.finalBatchPortfolio[token] += value;

                _addTokenIfNotExists(token);
            }
        }
    }

    // slither-disable-end reentrancy-no-eth

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
    }

    /* -------------------------------------------------------------------------- */
    /*                      LIQUIDITY ORCHESTRATOR FUNCTIONS                      */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc IInternalStateOrchestrator
    function updateNextUpdateTime() external onlyLiquidityOrchestrator {
        if (currentPhase != InternalUpkeepPhase.Idle) revert ErrorsLib.SystemNotIdle();
        _nextUpdateTime = block.timestamp + epochDuration;
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getOrders(
        bool isSellLeg
    )
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory estimatedUnderlyingAmounts)
    {
        if (currentPhase != InternalUpkeepPhase.Idle) revert ErrorsLib.SystemNotIdle();

        address[] memory allTokens = _currentEpoch.tokens;
        uint16 count = _countOrders(allTokens, isSellLeg);

        tokens = new address[](count);
        amounts = new uint256[](count);
        estimatedUnderlyingAmounts = new uint256[](count);
        _populateLegOrders(allTokens, tokens, amounts, estimatedUnderlyingAmounts, isSellLeg);
    }

    /// @notice Counts the number of non-zero selling and buying orders
    /// @param allTokens Array of all tokens to check
    /// @param isSellLeg True if counting sell leg orders, false for buy leg orders
    /// @return count Number of tokens with non-zero orders
    function _countOrders(address[] memory allTokens, bool isSellLeg) private view returns (uint16 count) {
        uint16 allTokensLength = uint16(allTokens.length);

        for (uint16 i = 0; i < allTokensLength; ++i) {
            address token = allTokens[i];
            if (isSellLeg && _currentEpoch.sellingOrders[token] > 0) {
                ++count;
            }
            if (!isSellLeg && _currentEpoch.buyingOrders[token] > 0) {
                ++count;
            }
        }
    }

    /// @notice Populates the order arrays for a specific leg
    /// @param allTokens Array of all tokens
    /// @param tokens Array to populate with tokens
    /// @param amounts Array to populate with amounts
    /// @param estimatedUnderlyingAmounts Array to populate with estimated underlying amounts
    /// @param isSellLeg True if populating sell leg, false for buy leg
    function _populateLegOrders(
        address[] memory allTokens,
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory estimatedUnderlyingAmounts,
        bool isSellLeg
    ) private view {
        uint16 allTokensLength = uint16(allTokens.length);
        uint16 index = 0;

        for (uint16 i = 0; i < allTokensLength; ++i) {
            address token = allTokens[i];
            uint256 amount = isSellLeg ? _currentEpoch.sellingOrders[token] : _currentEpoch.buyingOrders[token];

            if (amount > 0) {
                tokens[index] = token;
                amounts[index] = amount;
                // Convert estimated amount from token decimals to underlying decimals
                uint256 rawEstimatedAmount = amount.mulDiv(_currentEpoch.priceArray[token], priceAdapterPrecision);
                estimatedUnderlyingAmounts[index] = UtilitiesLib.convertDecimals(
                    rawEstimatedAmount,
                    config.getTokenDecimals(token),
                    underlyingDecimals
                );
                ++index;
            }
        }
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getEpochTokens() external view returns (address[] memory tokens) {
        return _currentEpoch.tokens;
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getPriceOf(address token) external view returns (uint256 price) {
        return _currentEpoch.priceArray[token];
    }

    /// @inheritdoc IInternalStateOrchestrator
    function subtractPendingProtocolFees(uint256 amount) external onlyLiquidityOrchestrator {
        if (amount > pendingProtocolFees) revert ErrorsLib.InsufficientAmount();
        pendingProtocolFees -= amount;
    }

    /// @inheritdoc IInternalStateOrchestrator
    function updateBufferAmount(int256 deltaAmount) external onlyLiquidityOrchestrator {
        if (deltaAmount > 0) {
            bufferAmount += uint256(deltaAmount);
        } else if (deltaAmount < 0) {
            bufferAmount -= uint256(-deltaAmount);
        }
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getVaultTotalAssetsAll(
        address vault
    ) external view returns (uint256 totalAssetsForRedeem, uint256 totalAssetsForDeposit, uint256 totalAssets) {
        return (
            _currentEpoch.vaultsTotalAssetsForFulfillRedeem[vault],
            _currentEpoch.vaultsTotalAssetsForFulfillDeposit[vault],
            _currentEpoch.vaultsTotalAssets[vault]
        );
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getTransparentVaultsEpoch() external view returns (address[] memory vaults) {
        return transparentVaultsEpoch;
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getVaultPortfolio(address vault) external view returns (address[] memory tokens, uint256[] memory shares) {
        tokens = _currentEpoch.vaultPortfolioTokens[vault];
        shares = _currentEpoch.vaultPortfolioShares[vault];
    }

    /// @inheritdoc IInternalStateOrchestrator
    function pause() external onlyConfig {
        _pause();
    }

    /// @inheritdoc IInternalStateOrchestrator
    function unpause() external onlyConfig {
        _unpause();
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
