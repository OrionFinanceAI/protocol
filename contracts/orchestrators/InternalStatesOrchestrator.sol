// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
 */
contract InternalStatesOrchestrator is Ownable, ReentrancyGuard, IInternalStateOrchestrator {
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

    /// @notice Basis points factor
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;
    /// @notice Maximum transparent minibatch size
    uint8 public constant MAX_TRANSPARENT_MINIBATCH_SIZE = 8;

    /// @notice Action constants for checkUpkeep and performUpkeep
    bytes4 private constant ACTION_START = bytes4(keccak256("start()"));
    bytes4 private constant ACTION_PREPROCESS_T_VAULTS = bytes4(keccak256("preprocessTV(uint8)"));
    bytes4 private constant ACTION_BUFFER = bytes4(keccak256("buffer()"));
    bytes4 private constant ACTION_POSTPROCESS_T_VAULTS = bytes4(keccak256("postprocessTV(uint8)"));
    bytes4 private constant ACTION_BUILD_ORDERS = bytes4(keccak256("buildOrders()"));

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */
    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Price array - token address to estimated price [shares/assets]
        mapping(address => uint256) priceArray;
        /// @notice Initial batch portfolio - token address to estimated value [shares]
        mapping(address => uint256) initialBatchPortfolio;
        /// @notice Total assets - Orion vault address to estimated value [assets]
        mapping(address => uint256) vaultsTotalAssets;
        /// @notice Final batch portfolio - token address to estimated value [shares]
        mapping(address => uint256) finalBatchPortfolio;
        /// @notice Total assets for fulfill redeem - vault address to total assets for fulfillRedeem [assets]
        mapping(address => uint256) vaultsTotalAssetsForFulfillRedeem;
        /// @notice Total assets for fulfill deposit - vault address to total assets for fulfillDeposit [assets]
        mapping(address => uint256) vaultsTotalAssetsForFulfillDeposit;
        /// @notice Selling orders - token address to number of shares that needs to be sold [shares]
        mapping(address => uint256) sellingOrders;
        /// @notice Buying orders - token address to number of shares that needs to be bought [shares]
        mapping(address => uint256) buyingOrders;
        /// @notice Array of all tokens used in this epoch for iteration
        address[] tokens;
        /// @notice Mapping to track if a token has been added to avoid duplicates
        mapping(address => bool) tokenExists;
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
    /// @notice Counter for tracking processing cycles
    uint16 public epochCounter;

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

    /// @dev Restricts function to only owner or automation registry
    modifier onlyAuthorizedTrigger() {
        if (msg.sender != owner() && msg.sender != automationRegistry) {
            revert ErrorsLib.NotAuthorized();
        }
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
    constructor(address initialOwner, address config_, address automationRegistry_) Ownable(initialOwner) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
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
        epochCounter = 0;
        currentMinibatchIndex = 0;

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
        _nextUpdateTime = block.timestamp + epochDuration;
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

        vFeeCoefficient = _vFeeCoefficient;
        rsFeeCoefficient = _rsFeeCoefficient;
    }

    /* solhint-disable code-complexity */
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
        } else if (currentPhase == InternalUpkeepPhase.Buffering) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_BUFFER, uint8(0));
        } else if (currentPhase == InternalUpkeepPhase.PostprocessingTransparentVaults) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_POSTPROCESS_T_VAULTS, currentMinibatchIndex);
        } else if (currentPhase == InternalUpkeepPhase.BuildingOrders) {
            upkeepNeeded = true;
            performData = abi.encode(ACTION_BUILD_ORDERS, uint8(0));
        } else {
            upkeepNeeded = false;
            performData = "";
        }
    }

    /// @notice Performs state reading and estimation operations
    /// @param performData Encoded data containing the action type and minibatch index
    function performUpkeep(bytes calldata performData) external override onlyAuthorizedTrigger nonReentrant {
        if (performData.length < 5) revert ErrorsLib.InvalidArguments();

        (bytes4 action, uint8 minibatchIndex) = abi.decode(performData, (bytes4, uint8));

        if (action == ACTION_START) {
            _handleStart();
        } else if (action == ACTION_PREPROCESS_T_VAULTS) {
            _preprocessTransparentMinibatch(minibatchIndex);
        } else if (action == ACTION_BUFFER) {
            _buffer();
        } else if (action == ACTION_POSTPROCESS_T_VAULTS) {
            _postprocessTransparentMinibatch(minibatchIndex);
        } else if (action == ACTION_BUILD_ORDERS) {
            _buildOrders();
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
        for (uint16 i = 0; i < allTransparent.length; ++i) {
            address v = allTransparent[i];
            if (IOrionVault(v).pendingDeposit() + IOrionVault(v).totalAssets() == 0) continue;
            // slither-disable-next-line unused-return
            (address[] memory tTokens, ) = IOrionTransparentVault(v).getIntent();
            if (tTokens.length == 0) continue;
            transparentVaultsEpoch.push(v);
        }
    }

    /// @notice Updates the next update time and resets the previous epoch state variables
    function _handleStart() internal {
        // Validate current phase
        if (!_shouldTriggerUpkeep() || !config.isSystemIdle()) revert ErrorsLib.TooEarly();

        for (uint16 i = 0; i < _currentEpoch.tokens.length; ++i) {
            address token = _currentEpoch.tokens[i];
            delete _currentEpoch.priceArray[token];
            delete _currentEpoch.initialBatchPortfolio[token];
            delete _currentEpoch.vaultsTotalAssets[token];
            delete _currentEpoch.vaultsTotalAssetsForFulfillRedeem[token];
            delete _currentEpoch.vaultsTotalAssetsForFulfillDeposit[token];
            delete _currentEpoch.finalBatchPortfolio[token];
            delete _currentEpoch.sellingOrders[token];
            delete _currentEpoch.buyingOrders[token];
            delete _currentEpoch.tokenExists[token];
        }
        delete _currentEpoch.tokens;

        // Build filtered vault lists for this epoch
        _buildTransparentVaultsEpoch();

        if (transparentVaultsEpoch.length > 0) {
            _nextUpdateTime = block.timestamp + epochDuration;
            currentPhase = InternalUpkeepPhase.PreprocessingTransparentVaults;
        }
    }

    // slither-disable-start reentrancy-no-eth

    /// @notice Preprocesses minibatch of transparent vaults
    /// @param minibatchIndex The index of the minibatch to process
    function _preprocessTransparentMinibatch(uint8 minibatchIndex) internal {
        if (currentPhase != InternalUpkeepPhase.PreprocessingTransparentVaults) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;

        uint16 i0 = minibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;
        if (i1 > transparentVaultsEpoch.length || i1 == transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length);
            currentPhase = InternalUpkeepPhase.Buffering;
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
            uint256 protocolVolumeFee = uint256(vFeeCoefficient).mulDiv(totalAssets, BASIS_POINTS_FACTOR);
            protocolVolumeFee = protocolVolumeFee.mulDiv(epochDuration, 365 days);
            pendingProtocolFees += protocolVolumeFee;
            totalAssets -= protocolVolumeFee;

            // STEP 3 & 4: CURATOR FEES (Management + Performance)
            uint256 curatorFee = vault.curatorFee(totalAssets);

            totalAssets -= curatorFee;
            _currentEpoch.vaultsTotalAssetsForFulfillRedeem[address(vault)] = totalAssets;

            uint256 protocolRevenueShareFee = uint256(rsFeeCoefficient).mulDiv(curatorFee, BASIS_POINTS_FACTOR);
            pendingProtocolFees += protocolRevenueShareFee;
            curatorFee -= protocolRevenueShareFee;
            vault.accrueCuratorFees(epochCounter, curatorFee);

            // STEP 5: WITHDRAWAL EXCHANGE RATE (based on post-fee totalAssets)
            uint256 pendingRedeem = vault.convertToAssetsWithPITTotalAssets(
                vault.pendingRedeem(),
                totalAssets,
                Math.Rounding.Floor
            );

            // STEP 6: DEPOSIT PROCESSING (add deposits, subtract withdrawals)
            totalAssets -= pendingRedeem;
            uint256 pendingDeposit = vault.pendingDeposit();
            _currentEpoch.vaultsTotalAssetsForFulfillDeposit[address(vault)] = totalAssets;
            totalAssets += pendingDeposit;
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
        if (currentPhase != InternalUpkeepPhase.Buffering) {
            revert ErrorsLib.InvalidState();
        }
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
        for (uint16 i = 0; i < nTransparentVaults; ++i) {
            address vault = transparentVaultsEpoch[i];
            uint256 vaultAssets = _currentEpoch.vaultsTotalAssets[address(vault)];
            uint256 vaultBufferCost = deltaBufferAmount.mulDiv(vaultAssets, protocolTotalAssets);
            _currentEpoch.vaultsTotalAssets[address(vault)] -= vaultBufferCost;
        }
        bufferAmount += deltaBufferAmount;
    }

    /// @notice Postprocesses minibatch of transparent vaults
    /// @param minibatchIndex The index of the minibatch to postprocess
    function _postprocessTransparentMinibatch(uint8 minibatchIndex) internal {
        if (currentPhase != InternalUpkeepPhase.PostprocessingTransparentVaults) {
            revert ErrorsLib.InvalidState();
        }
        ++currentMinibatchIndex;
        uint16 i0 = minibatchIndex * transparentMinibatchSize;
        uint16 i1 = i0 + transparentMinibatchSize;

        if (i1 > transparentVaultsEpoch.length || i1 == transparentVaultsEpoch.length) {
            i1 = uint16(transparentVaultsEpoch.length); // Last minibatch, go to next phase.
            currentPhase = InternalUpkeepPhase.BuildingOrders;
            currentMinibatchIndex = 0;
        }

        for (uint16 i = i0; i < i1; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(transparentVaultsEpoch[i]);

            (address[] memory intentTokens, uint32[] memory intentWeights) = vault.getIntent();
            uint256 finalTotalAssets = _currentEpoch.vaultsTotalAssets[address(vault)];

            IOrionTransparentVault.PortfolioPosition[]
                memory portfolio = new IOrionTransparentVault.PortfolioPosition[](intentTokens.length);

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

                portfolio[j] = IOrionTransparentVault.PortfolioPosition({ token: token, shares: value });

                _currentEpoch.finalBatchPortfolio[token] += value;
                _addTokenIfNotExists(token);
            }
            vault.updateVaultState(portfolio, finalTotalAssets);
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

    /// @inheritdoc IInternalStateOrchestrator
    function getOrders()
        external
        view
        returns (
            address[] memory sellingTokens,
            uint256[] memory sellingAmounts,
            address[] memory buyingTokens,
            uint256[] memory buyingAmounts,
            uint256[] memory sellingEstimatedUnderlyingAmounts,
            uint256[] memory buyingEstimatedUnderlyingAmounts
        )
    {
        if (currentPhase != InternalUpkeepPhase.Idle) revert ErrorsLib.SystemNotIdle();

        address[] memory allTokens = _currentEpoch.tokens;
        (uint16 sellingCount, uint16 buyingCount) = _countOrders(allTokens);

        // Initialize arrays with correct sizes (only for non-zero values)
        sellingTokens = new address[](sellingCount);
        sellingAmounts = new uint256[](sellingCount);
        buyingTokens = new address[](buyingCount);
        buyingAmounts = new uint256[](buyingCount);
        sellingEstimatedUnderlyingAmounts = new uint256[](sellingCount);
        buyingEstimatedUnderlyingAmounts = new uint256[](buyingCount);

        // Populate arrays with non-zero values
        _populateOrders(
            allTokens,
            sellingTokens,
            sellingAmounts,
            sellingEstimatedUnderlyingAmounts,
            buyingTokens,
            buyingAmounts,
            buyingEstimatedUnderlyingAmounts
        );
    }

    /// @notice Counts the number of non-zero selling and buying orders
    /// @param allTokens Array of all tokens to check
    /// @return sellingCount Number of tokens with non-zero selling orders
    /// @return buyingCount Number of tokens with non-zero buying orders
    function _countOrders(address[] memory allTokens) private view returns (uint16 sellingCount, uint16 buyingCount) {
        uint16 allTokensLength = uint16(allTokens.length);

        for (uint16 i = 0; i < allTokensLength; ++i) {
            address token = allTokens[i];
            if (_currentEpoch.sellingOrders[token] > 0) {
                ++sellingCount;
            }
            if (_currentEpoch.buyingOrders[token] > 0) {
                ++buyingCount;
            }
        }
    }

    /// @notice Populates the order arrays with non-zero values
    /// @param allTokens Array of all tokens
    /// @param sellingTokens Array to populate with selling tokens
    /// @param sellingAmounts Array to populate with selling amounts
    /// @param sellingEstimatedUnderlyingAmounts Array to populate with selling estimated amounts
    /// @param buyingTokens Array to populate with buying tokens
    /// @param buyingAmounts Array to populate with buying amounts
    /// @param buyingEstimatedUnderlyingAmounts Array to populate with buying estimated amounts
    function _populateOrders(
        address[] memory allTokens,
        address[] memory sellingTokens,
        uint256[] memory sellingAmounts,
        uint256[] memory sellingEstimatedUnderlyingAmounts,
        address[] memory buyingTokens,
        uint256[] memory buyingAmounts,
        uint256[] memory buyingEstimatedUnderlyingAmounts
    ) private view {
        uint16 allTokensLength = uint16(allTokens.length);
        uint16 sellingIndex = 0;
        uint16 buyingIndex = 0;

        for (uint16 i = 0; i < allTokensLength; ++i) {
            address token = allTokens[i];
            uint256 sellingAmount = _currentEpoch.sellingOrders[token];
            uint256 buyingAmount = _currentEpoch.buyingOrders[token];

            if (sellingAmount > 0) {
                sellingTokens[sellingIndex] = token;
                sellingAmounts[sellingIndex] = sellingAmount;
                sellingEstimatedUnderlyingAmounts[sellingIndex] = sellingAmount.mulDiv(
                    _currentEpoch.priceArray[token],
                    priceAdapterPrecision
                );
                ++sellingIndex;
            }
            if (buyingAmount > 0) {
                buyingTokens[buyingIndex] = token;
                buyingAmounts[buyingIndex] = buyingAmount;
                buyingEstimatedUnderlyingAmounts[buyingIndex] = buyingAmount.mulDiv(
                    _currentEpoch.priceArray[token],
                    priceAdapterPrecision
                );
                ++buyingIndex;
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
    function getVaultTotalAssetsForFulfillRedeem(address vault) external view returns (uint256 totalAssets) {
        return _currentEpoch.vaultsTotalAssetsForFulfillRedeem[vault];
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getVaultTotalAssetsForFulfillDeposit(address vault) external view returns (uint256 totalAssets) {
        return _currentEpoch.vaultsTotalAssetsForFulfillDeposit[vault];
    }

    /// @inheritdoc IInternalStateOrchestrator
    function getTransparentVaultsEpoch() external view returns (address[] memory vaults) {
        return transparentVaultsEpoch;
    }
}
