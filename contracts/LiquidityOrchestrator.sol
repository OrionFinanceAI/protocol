// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ILiquidityOrchestrator.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IPriceAdapterRegistry.sol";
import "./libraries/EventsLib.sol";
import "./interfaces/IOrionVault.sol";
import "./interfaces/IOrionTransparentVault.sol";
import "./interfaces/ISP1Verifier.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./interfaces/IExecutionAdapter.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
/**
 * @title Liquidity Orchestrator
 * @notice Contract that orchestrates liquidity operations
 * @author Orion Finance
 * @dev This contract is responsible for:
 *      - Executing actual buy and sell orders on investment universe;
 *      - Processing withdrawal requests from LPs;
 *      - Handling slippage and market execution differences from adapter price estimates via liquidity buffer.
 * @custom:security-contact security@orionfinance.ai
 */
contract LiquidityOrchestrator is
    Initializable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransient,
    PausableUpgradeable,
    UUPSUpgradeable,
    ILiquidityOrchestrator
{
    using Math for uint256;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Basis points factor
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;

    /* -------------------------------------------------------------------------- */
    /*                                 CONTRACTS                                  */
    /* -------------------------------------------------------------------------- */
    /// @notice Chainlink Automation Registry address
    address public automationRegistry;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice The address of the SP1 verifier contract.
    ISP1Verifier public verifier;

    /// @notice The verification key for the Orion Internal State Orchestrator.
    bytes32 public vKey;

    /// @notice Price Adapter Registry contract
    IPriceAdapterRegistry public priceAdapterRegistry;

    /// @notice Execution adapters mapping for assets
    mapping(address => IExecutionAdapter) public executionAdapterOf;

    /* -------------------------------------------------------------------------- */
    /*                               UPKEEP STATE                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Epoch duration
    uint32 public epochDuration;

    /// @notice Timestamp when the next upkeep is allowed
    uint256 private _nextUpdateTime;

    /// @notice Execution minibatch size
    uint8 public executionMinibatchSize;

    /// @notice Minibatch size for fulfill deposit and redeem processing
    uint8 public minibatchSize;

    /// @notice Upkeep phase
    LiquidityUpkeepPhase public currentPhase;

    /// @notice Current minibatch index
    uint8 public currentMinibatchIndex;

    /// @notice Target buffer ratio
    uint256 public targetBufferRatio;

    /// @notice Slippage tolerance
    uint256 public slippageTolerance;

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */

    /// @notice Epoch counter
    uint256 public epochCounter;

    /// @notice Live buffer amount [assets]
    uint256 public bufferAmount;

    /// @notice Pending protocol fees [assets]
    uint256 public pendingProtocolFees;

    /// @notice Tokens that failed during the current epoch's sell/buy execution (cleared at epoch end)
    address[] private _failedEpochTokens;

    /// @notice Cached assets hash from last full commitment build
    bytes32 private _cachedAssetsHash;
    /// @notice Cached vaults hash from last full commitment build
    bytes32 private _cachedVaultsHash;

    /// @notice Buffer snapshot captured at epoch start and used as deterministic proof input anchor [assets]
    uint256 public initialEpochBufferAmount;

    /// @notice Epoch protocol fees to accrue when transitioning to ProcessVaultOperations.
    uint256 private _pendingEpochProtocolFees;

    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Transparent vaults associated to the current epoch
        address[] vaultsEpoch;
        /// @notice Prices of assets in the current epoch [priceAdapterDecimals]
        mapping(address => uint256) pricesEpoch;
        /// @notice Active volume fee coefficient for current epoch
        uint16 activeVFeeCoefficient;
        /// @notice Active revenue share fee coefficient for current epoch
        uint16 activeRsFeeCoefficient;
        /// @notice Active fee model for each vault in current epoch
        mapping(address => IOrionVault.FeeModel) feeModel;
        /// @notice Epoch state commitment
        bytes32 epochStateCommitment;
    }

    /// @notice Current epoch state
    EpochState internal _currentEpoch;

    /// @notice Address of the upgrade timelock that must authorise all implementation upgrades
    address public upgradeTimelock;

    /// @notice Number of vault leaves folded into the commitment per StateCommitment upkeep step
    uint8 public commitmentMinibatchSize;

    /// @notice Running vault leaf fold accumulator during StateCommitment phase
    bytes32 private _partialVaultsHash;

    /// @notice Number of vault leaves already folded this epoch
    uint16 private _commitmentBatchIndex;

    /// @notice On-chain resume cursor for the active sell/buy minibatch window.
    uint16 public completedInCurrentMinibatch;

    /* -------------------------------------------------------------------------- */
    /*                                MODIFIERS                                   */
    /* -------------------------------------------------------------------------- */

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

    /// @dev Restricts function to only owner or guardian
    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != config.guardian()) {
            revert ErrorsLib.NotAuthorized();
        }
        _;
    }

    /// @dev Restricts function to only self
    ///      Used on _executeSell and _executeBuy so they can stay external (required for try/catch)
    modifier onlySelf() {
        if (msg.sender != address(this)) revert ErrorsLib.NotAuthorized();
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
    /// @param verifier_ The address of the SP1 verifier contract
    /// @param vKey_ The verification key for the Orion Internal State Orchestrator
    function initialize(
        address initialOwner,
        address config_,
        address automationRegistry_,
        address verifier_,
        bytes32 vKey_
    ) public initializer {
        if (initialOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (automationRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (verifier_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (vKey_ == bytes32(0)) revert ErrorsLib.InvalidArguments();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();

        config = IOrionConfig(config_);
        underlyingAsset = address(config.underlyingAsset());
        priceAdapterRegistry = IPriceAdapterRegistry(config.priceAdapterRegistry());
        automationRegistry = automationRegistry_;
        verifier = ISP1Verifier(verifier_);
        vKey = vKey_;

        currentPhase = LiquidityUpkeepPhase.Idle;

        executionMinibatchSize = 1;
        minibatchSize = 1;
        commitmentMinibatchSize = 1;

        slippageTolerance = 0;

        epochDuration = 1 days;
        _nextUpdateTime = block.timestamp + epochDuration;
    }

    /* -------------------------------------------------------------------------- */
    /*                                OWNER FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function updateEpochDuration(uint32 newEpochDuration) external onlyOwnerOrGuardian {
        if (newEpochDuration == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        epochDuration = newEpochDuration;
        _nextUpdateTime = Math.min(block.timestamp + epochDuration, _nextUpdateTime);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateExecutionMinibatchSize(uint8 _executionMinibatchSize) external onlyOwnerOrGuardian {
        if (_executionMinibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        executionMinibatchSize = _executionMinibatchSize;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateMinibatchSize(uint8 _minibatchSize) external onlyOwnerOrGuardian {
        if (_minibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        minibatchSize = _minibatchSize;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateCommitmentMinibatchSize(uint8 _commitmentMinibatchSize) external onlyOwnerOrGuardian {
        if (_commitmentMinibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (commitmentMinibatchSize != 0 && !config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        commitmentMinibatchSize = _commitmentMinibatchSize;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateAutomationRegistry(address newAutomationRegistry) external onlyOwner {
        if (newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();

        automationRegistry = newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(newAutomationRegistry);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert ErrorsLib.ZeroAddress();
        verifier = ISP1Verifier(newVerifier);
        emit EventsLib.SP1VerifierUpdated(newVerifier);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateVKey(bytes32 newvKey) external onlyOwner {
        if (newvKey == bytes32(0)) revert ErrorsLib.InvalidArguments();
        vKey = newvKey;
        emit EventsLib.VKeyUpdated(newvKey);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function setTargetBufferRatio(uint256 _targetBufferRatio) external onlyOwner {
        if (_targetBufferRatio == 0) revert ErrorsLib.InvalidArguments();
        // 5%
        if (_targetBufferRatio > 500) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        targetBufferRatio = _targetBufferRatio;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner {
        if (_slippageTolerance > BASIS_POINTS_FACTOR) revert ErrorsLib.InvalidArguments();
        slippageTolerance = _slippageTolerance;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function depositLiquidity(uint256 amount) external {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (currentPhase != LiquidityUpkeepPhase.Idle) revert ErrorsLib.SystemNotIdle();

        // Transfer underlying assets from the caller to this contract
        IERC20(underlyingAsset).safeTransferFrom(msg.sender, address(this), amount);

        // Update buffer amount
        _updateBufferAmount(int256(amount));

        emit EventsLib.LiquidityDeposited(msg.sender, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function withdrawLiquidity(uint256 amount) external onlyOwner {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (currentPhase != LiquidityUpkeepPhase.Idle) revert ErrorsLib.SystemNotIdle();

        // Safety check: ensure withdrawal doesn't make buffer negative
        if (amount > bufferAmount) revert ErrorsLib.InsufficientAmount();

        // Update buffer amount
        _updateBufferAmount(-int256(amount));

        // Transfer underlying assets to the owner
        IERC20(underlyingAsset).safeTransfer(msg.sender, amount);

        emit EventsLib.LiquidityWithdrawn(msg.sender, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function claimProtocolFees(uint256 amount) external onlyOwner {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        if (amount > pendingProtocolFees) revert ErrorsLib.InsufficientAmount();
        pendingProtocolFees -= amount;

        IERC20(underlyingAsset).safeTransfer(msg.sender, amount);

        emit EventsLib.ProtocolFeesClaimed(amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function getEpochState() external view returns (EpochStateView memory) {
        // Build vault fee models array
        IOrionVault.FeeModel[] memory vaultFeeModels = new IOrionVault.FeeModel[](_currentEpoch.vaultsEpoch.length);
        for (uint16 i = 0; i < _currentEpoch.vaultsEpoch.length; ++i) {
            vaultFeeModels[i] = _currentEpoch.feeModel[_currentEpoch.vaultsEpoch[i]];
        }

        return
            EpochStateView({
                vaultsEpoch: _currentEpoch.vaultsEpoch,
                activeVFeeCoefficient: _currentEpoch.activeVFeeCoefficient,
                activeRsFeeCoefficient: _currentEpoch.activeRsFeeCoefficient,
                vaultFeeModels: vaultFeeModels,
                epochStateCommitment: _currentEpoch.epochStateCommitment
            });
    }

    /// @inheritdoc ILiquidityOrchestrator
    function getFailedEpochTokens() external view returns (address[] memory) {
        return _failedEpochTokens;
    }

    /* -------------------------------------------------------------------------- */
    /*                                CONFIG FUNCTIONS                            */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function setExecutionAdapter(address asset, IExecutionAdapter adapter) external onlyConfig {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        adapter.validateExecutionAdapter(asset);

        executionAdapterOf[asset] = adapter;
        emit EventsLib.ExecutionAdapterSet(asset, address(adapter));
    }

    /// @inheritdoc ILiquidityOrchestrator
    function pause() external onlyOwnerOrGuardian {
        _pause();
        emit EventsLib.ProtocolPaused(msg.sender);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function unpause() external onlyOwner {
        _unpause();
        emit EventsLib.ProtocolUnpaused(msg.sender);
    }

    /* -------------------------------------------------------------------------- */
    /*                                VAULT FUNCTIONS                             */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function returnDepositFunds(address user, uint256 amount) external {
        // Transfer funds back to the user
        if (!config.isOrionVault(msg.sender) && !config.isDecommissionedVault(msg.sender)) {
            revert ErrorsLib.NotAuthorized();
        }
        IERC20(underlyingAsset).safeTransfer(user, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function transferVaultFees(uint256 amount) external {
        address vault = msg.sender;

        if (!config.isOrionVault(vault) && !config.isDecommissionedVault(vault)) revert ErrorsLib.NotAuthorized();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        // Transfer underlying assets to the manager
        address manager = IOrionVault(vault).manager();
        IERC20(underlyingAsset).safeTransfer(manager, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function transferRedemptionFunds(address user, uint256 amount) external {
        // Verify the caller is a registered or decommissioned vault
        if (!config.isOrionVault(msg.sender) && !config.isDecommissionedVault(msg.sender)) {
            revert ErrorsLib.NotAuthorized();
        }

        if (amount > 0) {
            // Transfer underlying assets to the user
            IERC20(underlyingAsset).safeTransfer(user, amount);
        }
    }

    /// @inheritdoc ILiquidityOrchestrator
    function withdraw(uint256 assets, address receiver) external nonReentrant {
        if (!config.isDecommissionedVault(msg.sender)) revert ErrorsLib.NotAuthorized();

        IERC20(underlyingAsset).safeTransfer(receiver, assets);
    }

    /* -------------------------------------------------------------------------- */
    /*                                UPKEEP FUNCTIONS                            */
    /* -------------------------------------------------------------------------- */

    /// @inheritdoc ILiquidityOrchestrator
    function checkUpkeep() external view returns (bool upkeepNeeded) {
        if (currentPhase == LiquidityUpkeepPhase.Idle) {
            upkeepNeeded = _shouldTriggerUpkeep();
        } else {
            upkeepNeeded = true;
        }
    }

    /// @inheritdoc ILiquidityOrchestrator
    function performUpkeep(
        bytes calldata _publicValues,
        bytes calldata proofBytes,
        bytes calldata statesBytes
    ) external onlyAuthorizedTrigger nonReentrant whenNotPaused {
        if (currentPhase == LiquidityUpkeepPhase.Idle && _shouldTriggerUpkeep()) {
            _handleStart();
        } else if (currentPhase == LiquidityUpkeepPhase.StateCommitment) {
            _processCommitmentMinibatch();
        } else if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            StatesStruct memory states = _verifyPerformData(_publicValues, proofBytes, statesBytes);

            if (currentMinibatchIndex == 0) {
                bufferAmount = states.bufferAmount;
                _pendingEpochProtocolFees = states.epochProtocolFees;
            }

            _processMinibatchSell(states.sellLeg);
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            StatesStruct memory states = _verifyPerformData(_publicValues, proofBytes, statesBytes);
            _processMinibatchBuy(states.buyLeg);
        } else if (currentPhase == LiquidityUpkeepPhase.ProcessVaultOperations) {
            StatesStruct memory states = _verifyPerformData(_publicValues, proofBytes, statesBytes);
            _processMinibatchVaultsOperations(states.vaults);

            if (currentMinibatchIndex == 0) {
                // After the final minibatch, currentMinibatchIndex resets to 0, triggering epoch end
                address[] memory failedTokens = _failedEpochTokens;
                delete _failedEpochTokens;
                config.completeAssetsRemoval(failedTokens);
                // Emit epoch end and increment epoch counter.
                emit EventsLib.EpochEnd(epochCounter, states.nettedRebalanceVolumeUnderlying);
                ++epochCounter;
            }
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                                INTERNAL FUNCTIONS                          */
    /* -------------------------------------------------------------------------- */

    /// @notice Checks if upkeep should be triggered based on time
    /// @return True if upkeep should be triggered
    function _shouldTriggerUpkeep() internal view returns (bool) {
        // slither-disable-next-line timestamp
        return block.timestamp > _nextUpdateTime;
    }

    /// @notice Handles the start of the upkeep
    /// @dev No need to delete prices as they are either overwritten or associated with
    /// non-whitelisted assets.
    function _handleStart() internal {
        _buildVaultsEpoch();

        if (_currentEpoch.vaultsEpoch.length == 0) {
            // Defer the next upkeep by epoch duration
            _nextUpdateTime = block.timestamp + epochDuration;
            return;
        }

        // Freeze deterministic proof-input anchor at epoch start.
        initialEpochBufferAmount = bufferAmount;

        // Reset incremental commitment state for the new epoch
        _partialVaultsHash = bytes32(0);
        _commitmentBatchIndex = 0;
        completedInCurrentMinibatch = 0;

        currentPhase = LiquidityUpkeepPhase.StateCommitment;

        // Snapshot protocol fees at epoch start to ensure consistency throughout the epoch
        (_currentEpoch.activeVFeeCoefficient, _currentEpoch.activeRsFeeCoefficient) = config.activeProtocolFees();

        // Snapshot vault fee types at epoch start to ensure consistency throughout the epoch
        for (uint16 i = 0; i < _currentEpoch.vaultsEpoch.length; ++i) {
            IOrionVault.FeeModel memory feeModel = IOrionVault(_currentEpoch.vaultsEpoch[i]).activeFeeModel();
            _currentEpoch.feeModel[_currentEpoch.vaultsEpoch[i]] = feeModel;
        }

        address[] memory assets = config.getAllWhitelistedAssets();
        uint256[] memory prices = new uint256[](assets.length);
        for (uint16 i = 0; i < assets.length; ++i) {
            uint256 price = priceAdapterRegistry.getPrice(assets[i]);
            _currentEpoch.pricesEpoch[assets[i]] = price;
            prices[i] = price;
        }
        emit EventsLib.EpochStart(epochCounter, assets, prices);
    }

    /// @notice Build vaults list for the epoch
    function _buildVaultsEpoch() internal {
        address[] memory allTransparent = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        delete _currentEpoch.vaultsEpoch;

        for (uint16 i = 0; i < allTransparent.length; ++i) {
            _currentEpoch.vaultsEpoch.push(allTransparent[i]);
        }
    }

    /// @notice Folds the next batch of vault leaves into the running accumulator.
    function _processCommitmentMinibatch() internal {
        uint16 vaultCount = uint16(_currentEpoch.vaultsEpoch.length);
        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();

        uint16 i0 = _commitmentBatchIndex;
        uint16 i1 = i0 + uint16(commitmentMinibatchSize);
        if (i1 > vaultCount) {
            i1 = vaultCount;
        }

        for (uint16 i = i0; i < i1; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(_currentEpoch.vaultsEpoch[i]);
            IOrionVault.FeeModel memory feeModel = _currentEpoch.feeModel[_currentEpoch.vaultsEpoch[i]];

            (address[] memory portfolioTokens, uint256[] memory portfolioShares) = vault.getPortfolio();
            (address[] memory intentTokens, uint32[] memory intentWeights) = vault.getIntent();

            bytes32 portfolioHash = keccak256(abi.encode(portfolioTokens, portfolioShares));
            bytes32 intentHash = keccak256(abi.encode(intentTokens, intentWeights));

            bytes32 vaultLeaf = keccak256(
                abi.encode(
                    _currentEpoch.vaultsEpoch[i],
                    uint8(feeModel.feeType),
                    feeModel.performanceFee,
                    feeModel.managementFee,
                    feeModel.highWaterMark,
                    vault.pendingRedeem(maxFulfillBatchSize),
                    vault.pendingDeposit(maxFulfillBatchSize),
                    vault.totalSupply(),
                    vault.totalAssets(),
                    portfolioHash,
                    intentHash
                )
            );

            _partialVaultsHash = keccak256(abi.encode(_partialVaultsHash, vaultLeaf));
        }

        _commitmentBatchIndex = i1;

        // All vault leaves processed, seal the commitment and advance phase
        if (i1 == vaultCount) {
            address[] memory assets = config.getAllWhitelistedAssets();
            uint256[] memory assetPrices = getAssetPrices(assets);

            bytes32 protocolStateHash = _buildProtocolStateHash();
            bytes32 assetsHash = _aggregateAssetLeaves(assets, assetPrices);

            _cachedAssetsHash = assetsHash;
            _cachedVaultsHash = _partialVaultsHash;

            _currentEpoch.epochStateCommitment = keccak256(
                abi.encode(protocolStateHash, assetsHash, _partialVaultsHash)
            );

            completedInCurrentMinibatch = 0;
            currentPhase = LiquidityUpkeepPhase.SellingLeg;
            emit EventsLib.EpochStateCommitted(epochCounter, _currentEpoch.epochStateCommitment);
        }
    }

    /// @notice Builds the protocol state hash from static epoch parameters
    /// @return The protocol state hash
    function _buildProtocolStateHash() internal view returns (bytes32) {
        bytes32 protocolStateHash = keccak256(
            abi.encode(
                _currentEpoch.activeVFeeCoefficient,
                _currentEpoch.activeRsFeeCoefficient,
                config.maxFulfillBatchSize(),
                targetBufferRatio,
                config.priceAdapterDecimals(),
                config.strategistIntentDecimals(),
                epochDuration,
                config.getAllWhitelistedAssets(),
                config.getAllTokenDecimals(),
                config.riskFreeRate(),
                config.decommissioningAssets(),
                _failedEpochTokens,
                initialEpochBufferAmount
            )
        );
        return protocolStateHash;
    }

    /// @notice Aggregates asset leaves using sequential folding
    /// @param assets Array of asset addresses
    /// @param assetPrices Array of asset prices
    /// @return The aggregated assets hash
    function _aggregateAssetLeaves(
        address[] memory assets,
        uint256[] memory assetPrices
    ) internal pure returns (bytes32) {
        bytes32 assetsHash = bytes32(0);
        for (uint16 i = 0; i < assets.length; ++i) {
            bytes32 assetLeaf = keccak256(abi.encode(assets[i], assetPrices[i]));
            assetsHash = keccak256(abi.encode(assetsHash, assetLeaf));
        }
        return assetsHash;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function getAssetPrices(address[] memory assets) public view returns (uint256[] memory assetPrices) {
        assetPrices = new uint256[](assets.length);
        for (uint16 i = 0; i < assets.length; ++i) {
            assetPrices[i] = _currentEpoch.pricesEpoch[assets[i]];
        }
    }

    /// @notice Verifies the perform data
    /// @param _publicValues Encoded PublicValuesStruct containing input and output commitments
    /// @param proofBytes The zk-proof bytes
    /// @param statesBytes Encoded StatesStruct containing state transition payload.
    /// @return states The decoded StatesStruct
    function _verifyPerformData(
        bytes calldata _publicValues,
        bytes calldata proofBytes,
        bytes calldata statesBytes
    ) internal view returns (StatesStruct memory states) {
        PublicValuesStruct memory publicValues = abi.decode(_publicValues, (PublicValuesStruct));
        // Verify that the proof's input commitment matches the onchain input commitment
        if (publicValues.inputCommitment != _currentEpoch.epochStateCommitment) {
            revert ErrorsLib.CommitmentMismatch(publicValues.inputCommitment, _currentEpoch.epochStateCommitment);
        }

        // Decode statesBytes onchain
        states = abi.decode(statesBytes, (StatesStruct));

        // Verify that the computed output commitment matches the one in public values
        bytes32 outputCommitment = keccak256(abi.encode(states));
        if (publicValues.outputCommitment != outputCommitment) {
            revert ErrorsLib.CommitmentMismatch(publicValues.outputCommitment, outputCommitment);
        }
        verifier.verifyProof(vKey, _publicValues, proofBytes);
    }

    /// @notice Handles the sell action
    /// @param sellLeg The sell leg orders
    function _processMinibatchSell(SellLegOrders memory sellLeg) internal {
        _processMinibatchLeg(
            sellLeg.sellingTokens,
            sellLeg.sellingAmounts,
            sellLeg.sellingEstimatedUnderlyingAmounts,
            true
        );
    }

    /// @notice Handles the buy action
    /// @param buyLeg The buy leg orders
    function _processMinibatchBuy(BuyLegOrders memory buyLeg) internal {
        _processMinibatchLeg(buyLeg.buyingTokens, buyLeg.buyingAmounts, buyLeg.buyingEstimatedUnderlyingAmounts, false);
    }

    /// @notice Processes the next sell or buy minibatch window with resume support
    /// @param tokens Leg token addresses
    /// @param amounts Leg share amounts
    /// @param estimatedUnderlyingAmounts Leg underlying estimates
    /// @param isSell True for sell leg, false for buy leg
    // slither-disable-next-line reentrancy-no-eth
    function _processMinibatchLeg(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory estimatedUnderlyingAmounts,
        bool isSell
    ) internal {
        uint16 batchSize = executionMinibatchSize;
        uint16 i0 = currentMinibatchIndex * batchSize;
        uint16 i1 = i0 + batchSize;
        uint256 tokenCount = tokens.length;
        if (i1 > tokenCount) {
            i1 = uint16(tokenCount);
        }

        uint16 start = i0 + completedInCurrentMinibatch;
        if (start >= i1) {
            completedInCurrentMinibatch = 0;
            ++currentMinibatchIndex;
            _finalizeMinibatchLeg(isSell, i1 == tokenCount);
            return;
        }

        for (uint16 i = start; i < i1; ++i) {
            address token = tokens[i];
            uint256 amount = amounts[i];

            if (token == address(underlyingAsset)) {
                ++completedInCurrentMinibatch;
                continue;
            }
            if (amount == 0) {
                ++completedInCurrentMinibatch;
                continue;
            }

            if (isSell) {
                try this._executeSell(token, amount, estimatedUnderlyingAmounts[i]) {
                    ++completedInCurrentMinibatch;
                } catch {
                    _handleMinibatchLegFailure(token);
                    return;
                }
            } else {
                try this._executeBuy(token, amount, estimatedUnderlyingAmounts[i]) {
                    ++completedInCurrentMinibatch;
                } catch {
                    _handleMinibatchLegFailure(token);
                    return;
                }
            }
        }

        completedInCurrentMinibatch = 0;
        ++currentMinibatchIndex;
        _finalizeMinibatchLeg(isSell, i1 == tokenCount);
    }

    /// @notice Records a failed minibatch leg and refreshes the epoch commitment without advancing the minibatch index
    function _handleMinibatchLegFailure(address token) internal {
        _failedEpochTokens.push(token);
        _currentEpoch.epochStateCommitment = keccak256(
            abi.encode(_buildProtocolStateHash(), _cachedAssetsHash, _cachedVaultsHash)
        );
        emit EventsLib.EpochStateCommitted(epochCounter, _currentEpoch.epochStateCommitment);
    }

    /// @notice Applies phase transitions after a minibatch window completes successfully
    function _finalizeMinibatchLeg(bool isSell, bool legFinished) internal {
        if (!legFinished) {
            return;
        }

        currentMinibatchIndex = 0;
        completedInCurrentMinibatch = 0;

        if (isSell) {
            currentPhase = LiquidityUpkeepPhase.BuyingLeg;
        } else {
            pendingProtocolFees += _pendingEpochProtocolFees;
            emit EventsLib.ProtocolFeesAccrued(_pendingEpochProtocolFees);
            _pendingEpochProtocolFees = 0;
            currentPhase = LiquidityUpkeepPhase.ProcessVaultOperations;
        }
    }

    /// @notice Updates the buffer amount based on execution vs estimated amounts
    /// @param deltaAmount The amount to add/subtract from the buffer (can be negative)
    function _updateBufferAmount(int256 deltaAmount) internal {
        if (deltaAmount > 0) {
            bufferAmount += uint256(deltaAmount);
        } else if (deltaAmount < 0) {
            bufferAmount -= uint256(-deltaAmount);
        }
    }

    /// @notice Calculate maximum amount with slippage applied
    /// @param estimatedAmount The estimated amount
    /// @return The maximum amount with slippage applied
    function _calculateMaxWithSlippage(uint256 estimatedAmount) internal view returns (uint256) {
        return estimatedAmount.mulDiv(BASIS_POINTS_FACTOR + slippageTolerance, BASIS_POINTS_FACTOR);
    }

    /// @notice Calculate minimum amount with slippage applied
    /// @param estimatedAmount The estimated amount
    /// @return The minimum amount with slippage applied
    function _calculateMinWithSlippage(uint256 estimatedAmount) internal view returns (uint256) {
        return estimatedAmount.mulDiv(BASIS_POINTS_FACTOR - slippageTolerance, BASIS_POINTS_FACTOR);
    }

    /// @notice Executes a sell order
    /// @param asset The asset to sell
    /// @param sharesAmount The amount of shares to sell
    /// @param estimatedUnderlyingAmount The estimated underlying amount to receive
    function _executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external onlySelf {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        IERC20(asset).forceApprove(address(adapter), sharesAmount);

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        uint256 executionUnderlyingAmount = adapter.sell(asset, sharesAmount);

        // Validate slippage of trade is within tolerance.
        uint256 minUnderlyingAmount = _calculateMinWithSlippage(estimatedUnderlyingAmount);
        if (executionUnderlyingAmount < minUnderlyingAmount) {
            revert ErrorsLib.SlippageExceeded(asset, executionUnderlyingAmount, minUnderlyingAmount);
        }

        // Clean up approval
        IERC20(asset).forceApprove(address(adapter), 0);

        _updateBufferAmount(executionUnderlyingAmount.toInt256() - estimatedUnderlyingAmount.toInt256());
        emit EventsLib.EpochSellExecuted(
            epochCounter,
            asset,
            executionUnderlyingAmount,
            sharesAmount,
            estimatedUnderlyingAmount
        );
    }

    /// @notice Executes a buy order
    /// @param asset The asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    function _executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external onlySelf {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend underlying assets with slippage tolerance.
        // Slippage tolerance is enforced indirectly by capping the approval amount.
        uint256 maxWithSlippage = _calculateMaxWithSlippage(estimatedUnderlyingAmount);
        IERC20(underlyingAsset).forceApprove(address(adapter), maxWithSlippage);

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        uint256 executionUnderlyingAmount = adapter.buy(asset, sharesAmount);

        // Clean up approval
        IERC20(underlyingAsset).forceApprove(address(adapter), 0);

        _updateBufferAmount(estimatedUnderlyingAmount.toInt256() - executionUnderlyingAmount.toInt256());
        emit EventsLib.EpochBuyExecuted(
            epochCounter,
            asset,
            executionUnderlyingAmount,
            sharesAmount,
            estimatedUnderlyingAmount
        );
    }

    /// @notice Handles the vault operations
    /// @param vaults The vault states
    /// @dev vaults[] shall match _currentEpoch.vaultsEpoch[] in order
    function _processMinibatchVaultsOperations(VaultState[] memory vaults) internal {
        address[] memory vaultsEpoch = _currentEpoch.vaultsEpoch;

        uint16 i0 = currentMinibatchIndex * minibatchSize;
        uint16 i1 = i0 + minibatchSize;
        ++currentMinibatchIndex;

        if (i1 > vaultsEpoch.length || i1 == vaultsEpoch.length) {
            i1 = uint16(vaultsEpoch.length);
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
            completedInCurrentMinibatch = 0;
            _nextUpdateTime = block.timestamp + epochDuration;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address vaultAddress = vaultsEpoch[i];
            VaultState memory vaultState = vaults[i];

            _processSingleVaultOperations(
                vaultAddress,
                vaultState.processRedeem,
                vaultState.totalAssetsForDeposit,
                vaultState.totalAssetsForRedeem,
                vaultState.finalTotalAssets,
                vaultState.managementFee,
                vaultState.performanceFee,
                vaultState.tokens,
                vaultState.shares
            );
        }
    }

    /// @notice Processes deposit and redeem operations for a single vault
    /// @param vaultAddress The vault address
    /// @param processRedeem When false, redeem fulfillment is skipped even if pending requests exist
    /// @param totalAssetsForDeposit The total assets for deposit operations
    /// @param totalAssetsForRedeem The total assets for redeem operations
    /// @param finalTotalAssets The final total assets for the vault
    /// @param managementFee The management fee to accrue
    /// @param performanceFee The performance fee to accrue
    /// @param tokens The portfolio token addresses
    /// @param shares The portfolio token number of shares
    function _processSingleVaultOperations(
        address vaultAddress,
        bool processRedeem,
        uint256 totalAssetsForDeposit,
        uint256 totalAssetsForRedeem,
        uint256 finalTotalAssets,
        uint256 managementFee,
        uint256 performanceFee,
        address[] memory tokens,
        uint256[] memory shares
    ) internal {
        IOrionTransparentVault vaultContract = IOrionTransparentVault(vaultAddress);

        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        uint256 pendingRedeem = vaultContract.pendingRedeem(maxFulfillBatchSize);
        uint256 pendingDeposit = vaultContract.pendingDeposit(maxFulfillBatchSize);

        if (processRedeem && pendingRedeem > 0) {
            vaultContract.fulfillRedeem(totalAssetsForRedeem);
        }

        if (pendingDeposit > 0) {
            vaultContract.fulfillDeposit(totalAssetsForDeposit);
        }

        IOrionVault(vaultAddress).accrueVaultFees(managementFee, performanceFee);
        vaultContract.updateVaultState(tokens, shares, finalTotalAssets);

        if (config.isDecommissioningVault(vaultAddress)) {
            // Finalize only when all queued requests are processed and no non-underlying positions remain open.
            bool noRequests = vaultContract.pendingRedeemCount() == 0 && vaultContract.pendingDepositCount() == 0;
            bool portfolioLiquidated =
                (tokens.length == 0 && finalTotalAssets == 0) || (tokens.length == 1 && tokens[0] == underlyingAsset);

            if (noRequests && portfolioLiquidated) {
                config.completeVaultDecommissioning(vaultAddress);
            }
        }
    }

    /// @notice Sets the upgrade timelock address.
    /// @dev If no timelock is set yet, only the owner may call this. Once a timelock is active,
    ///      only the timelock itself may replace it, preventing the owner from bypassing the delay.
    /// @param newTimelock The new timelock address (e.g. OpenZeppelin TimelockController); address(0) not permitted
    function setUpgradeTimelock(address newTimelock) external {
        if (upgradeTimelock == address(0)) {
            if (msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        } else {
            if (msg.sender != upgradeTimelock) revert ErrorsLib.NotAuthorized();
        }
        if (newTimelock == address(0)) revert ErrorsLib.ZeroAddress();
        upgradeTimelock = newTimelock;
        emit EventsLib.UpgradeTimelockSet(address(this), newTimelock);
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev Requires the caller to be the upgrade timelock (if set) or the owner (during initial
    ///      bootstrapping before a timelock has been configured).
    // solhint-disable-next-line use-natspec
    function _authorizeUpgrade(address) internal view override {
        if (upgradeTimelock != address(0)) {
            if (msg.sender != upgradeTimelock) revert ErrorsLib.NotAuthorized();
        } else {
            if (msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        }
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[46] private __gap;
}
