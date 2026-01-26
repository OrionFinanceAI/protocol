// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
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
    ReentrancyGuardUpgradeable,
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

    /// @notice Maximum minibatch size
    uint8 public constant MAX_MINIBATCH_SIZE = 8;

    /// @notice Maximum epoch duration (2 weeks)
    uint32 public constant MAX_EPOCH_DURATION = 14 days;

    /* -------------------------------------------------------------------------- */
    /*                                 EPOCH STATE                                */
    /* -------------------------------------------------------------------------- */

    /// @notice Epoch counter
    uint256 public epochCounter;

    /// @notice Buffer amount [assets]
    uint256 public bufferAmount;

    /// @notice Delta buffer amount for current epoch [assets]
    int256 public deltaBufferAmount;

    /// @notice Pending protocol fees [assets]
    uint256 public pendingProtocolFees;

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
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        config = IOrionConfig(config_);
        underlyingAsset = address(config.underlyingAsset());
        priceAdapterRegistry = IPriceAdapterRegistry(config.priceAdapterRegistry());
        automationRegistry = automationRegistry_;
        verifier = ISP1Verifier(verifier_);
        vKey = vKey_;

        currentPhase = LiquidityUpkeepPhase.Idle;
        minibatchSize = 1;
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
        if (newEpochDuration > MAX_EPOCH_DURATION) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        epochDuration = newEpochDuration;
        _nextUpdateTime = Math.min(block.timestamp + epochDuration, _nextUpdateTime);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateMinibatchSize(uint8 _minibatchSize) external onlyOwnerOrGuardian {
        if (_minibatchSize == 0) revert ErrorsLib.InvalidArguments();
        if (_minibatchSize > MAX_MINIBATCH_SIZE) revert ErrorsLib.InvalidArguments();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();
        minibatchSize = _minibatchSize;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateAutomationRegistry(address newAutomationRegistry) external onlyOwner {
        if (newAutomationRegistry == address(0)) revert ErrorsLib.ZeroAddress();

        automationRegistry = newAutomationRegistry;
        emit EventsLib.AutomationRegistryUpdated(newAutomationRegistry);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateVerifier(address newVerifier) external onlyOwnerOrGuardian {
        if (newVerifier == address(0)) revert ErrorsLib.ZeroAddress();
        verifier = ISP1Verifier(newVerifier);
        emit EventsLib.SP1VerifierUpdated(newVerifier);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function updateVKey(bytes32 newvKey) external onlyOwner {
        vKey = newvKey;
        emit EventsLib.VKeyUpdated(newvKey);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function setTargetBufferRatio(uint256 _targetBufferRatio) external onlyOwner {
        if (_targetBufferRatio == 0) revert ErrorsLib.InvalidArguments();
        // 5%
        if (_targetBufferRatio > 500) revert ErrorsLib.InvalidArguments();
        targetBufferRatio = _targetBufferRatio;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyOwner {
        slippageTolerance = _slippageTolerance;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function depositLiquidity(uint256 amount) external {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (currentPhase == LiquidityUpkeepPhase.StateCommitment) revert ErrorsLib.NotAuthorized();

        // Transfer underlying assets from the caller to this contract
        IERC20(underlyingAsset).safeTransferFrom(msg.sender, address(this), amount);

        // Update buffer amount
        _updateBufferAmount(int256(amount));

        emit EventsLib.LiquidityDeposited(msg.sender, amount);
    }

    /// @inheritdoc ILiquidityOrchestrator
    function withdrawLiquidity(uint256 amount) external onlyOwner {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);
        if (currentPhase == LiquidityUpkeepPhase.StateCommitment) revert ErrorsLib.NotAuthorized();

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
        // TODO: when pendingProtocolFees updated in LO from zkVM inputs, emit event also when accrued.
        // If possible, do so by accruing component, like done for vault fees.
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
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        // Transfer funds back to the user
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
        // Verify the caller is a registered vault
        if (!config.isOrionVault(msg.sender)) revert ErrorsLib.NotAuthorized();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(underlyingAsset);

        // Transfer underlying assets to the user
        IERC20(underlyingAsset).safeTransfer(user, amount);
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
        if (currentPhase == LiquidityUpkeepPhase.Idle && _shouldTriggerUpkeep()) {
            upkeepNeeded = true;
        } else if (currentPhase == LiquidityUpkeepPhase.StateCommitment) {
            upkeepNeeded = true;
        } else if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            upkeepNeeded = true;
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            upkeepNeeded = true;
        } else if (currentPhase == LiquidityUpkeepPhase.ProcessVaultOperations) {
            upkeepNeeded = true;
        } else {
            upkeepNeeded = false;
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
            _currentEpoch.epochStateCommitment = _buildEpochStateCommitment();
            currentPhase = LiquidityUpkeepPhase.SellingLeg;
        } else if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            StatesStruct memory states = _verifyPerformData(_publicValues, proofBytes, statesBytes);
            _processSellLeg(states.sellLeg);
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            StatesStruct memory states = _verifyPerformData(_publicValues, proofBytes, statesBytes);
            _processBuyLeg(states.buyLeg);
        } else if (currentPhase == LiquidityUpkeepPhase.ProcessVaultOperations) {
            StatesStruct memory states = _verifyPerformData(_publicValues, proofBytes, statesBytes);
            _processVaultOperations(states.vaults);
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
        // Build filtered vault lists for this epoch
        _buildVaultsEpoch();

        if (_currentEpoch.vaultsEpoch.length > 0) {
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
    }

    /// @notice Build filtered transparent vaults list for the epoch
    function _buildVaultsEpoch() internal {
        address[] memory allTransparent = config.getAllOrionVaults(EventsLib.VaultType.Transparent);
        delete _currentEpoch.vaultsEpoch;

        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        for (uint16 i = 0; i < allTransparent.length; ++i) {
            address v = allTransparent[i];
            if (IOrionVault(v).pendingDeposit(maxFulfillBatchSize) + IOrionVault(v).totalAssets() == 0) continue;
            _currentEpoch.vaultsEpoch.push(v);
        }
    }

    /// @notice Builds an epoch state commitment from the full epoch state
    /// @dev Uses domain separation for cryptographic robustness.
    /// @return The epoch state commitment
    function _buildEpochStateCommitment() internal view returns (bytes32) {
        address[] memory assets = config.getAllWhitelistedAssets();
        uint256[] memory assetPrices = getAssetPrices(assets);
        VaultStateData memory vaultData = _getVaultStateData();

        bytes32 protocolStateHash = _buildProtocolStateHash();

        bytes32 assetsHash = _aggregateAssetLeaves(assets, assetPrices);

        bytes32 vaultsHash = _aggregateVaultLeaves(vaultData);

        bytes32 epochStateCommitment = keccak256(
            abi.encode(protocolStateHash, assetsHash, vaultsHash)
        );

        return epochStateCommitment;
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
                bufferAmount,
                config.priceAdapterDecimals(),
                config.strategistIntentDecimals(),
                epochDuration,
                config.getAllWhitelistedAssets(),
                config.getAllTokenDecimals()
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

    /// @notice Aggregates vault leaves using sequential folding
    /// @param vaultData Struct containing all vault state data
    /// @return The aggregated vaults hash
    function _aggregateVaultLeaves(VaultStateData memory vaultData) internal view returns (bytes32) {
        bytes32 vaultsHash = bytes32(0);
        uint16 vaultCount = uint16(_currentEpoch.vaultsEpoch.length);
        for (uint16 i = 0; i < vaultCount; ++i) {
            bytes32 portfolioHash = keccak256(abi.encode(vaultData.portfolioTokens[i], vaultData.portfolioShares[i]));
            bytes32 intentHash = keccak256(abi.encode(vaultData.intentTokens[i], vaultData.intentWeights[i]));

            bytes32 vaultLeaf = keccak256(
                abi.encode(
                    _currentEpoch.vaultsEpoch[i],
                    vaultData.feeTypes[i],
                    vaultData.performanceFees[i],
                    vaultData.managementFees[i],
                    vaultData.highWaterMarks[i],
                    vaultData.pendingRedeems[i],
                    vaultData.pendingDeposits[i],
                    portfolioHash,
                    intentHash
                )
            );

            // Fold into aggregate
            vaultsHash = keccak256(abi.encode(vaultsHash, vaultLeaf));
        }
        return vaultsHash;
    }

    /// @inheritdoc ILiquidityOrchestrator
    function getAssetPrices(address[] memory assets) public view returns (uint256[] memory assetPrices) {
        assetPrices = new uint256[](assets.length);
        for (uint16 i = 0; i < assets.length; ++i) {
            assetPrices[i] = _currentEpoch.pricesEpoch[assets[i]];
        }
    }

    /// @notice Gets vault state data for all vaults in the epoch
    /// @return vaultData Struct containing all vault state data
    function _getVaultStateData() internal view returns (VaultStateData memory vaultData) {
        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        uint16 vaultCount = uint16(_currentEpoch.vaultsEpoch.length);

        vaultData.feeTypes = new uint8[](vaultCount);
        vaultData.performanceFees = new uint16[](vaultCount);
        vaultData.managementFees = new uint16[](vaultCount);
        vaultData.highWaterMarks = new uint256[](vaultCount);
        vaultData.pendingRedeems = new uint256[](vaultCount);
        vaultData.pendingDeposits = new uint256[](vaultCount);
        vaultData.portfolioTokens = new address[][](vaultCount);
        vaultData.portfolioShares = new uint256[][](vaultCount);
        vaultData.intentTokens = new address[][](vaultCount);
        vaultData.intentWeights = new uint32[][](vaultCount);

        for (uint16 i = 0; i < vaultCount; ++i) {
            IOrionTransparentVault vault = IOrionTransparentVault(_currentEpoch.vaultsEpoch[i]);
            IOrionVault.FeeModel memory feeModel = _currentEpoch.feeModel[_currentEpoch.vaultsEpoch[i]];

            vaultData.feeTypes[i] = uint8(feeModel.feeType);
            vaultData.performanceFees[i] = feeModel.performanceFee;
            vaultData.managementFees[i] = feeModel.managementFee;
            vaultData.highWaterMarks[i] = feeModel.highWaterMark;
            vaultData.pendingRedeems[i] = vault.pendingRedeem(maxFulfillBatchSize);
            vaultData.pendingDeposits[i] = vault.pendingDeposit(maxFulfillBatchSize);
            (vaultData.portfolioTokens[i], vaultData.portfolioShares[i]) = vault.getPortfolio();
            (vaultData.intentTokens[i], vaultData.intentWeights[i]) = vault.getIntent();
        }
    }

    /// @notice Verifies the perform data
    /// @param _publicValues Encoded PublicValuesStruct containing input and output commitments
    /// @param proofBytes The zk-proof bytes
    /// @param statesBytes Encoded StatesStruct containing vaults, buy leg, and sell leg data
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
    function _processSellLeg(SellLegOrders memory sellLeg) internal {
        currentPhase = LiquidityUpkeepPhase.BuyingLeg;

        for (uint16 i = 0; i < sellLeg.sellingTokens.length; ++i) {
            address token = sellLeg.sellingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = sellLeg.sellingAmounts[i];
            _executeSell(token, amount, sellLeg.sellingEstimatedUnderlyingAmounts[i]);
        }
    }

    /// @notice Handles the buy action
    /// @param buyLeg The buy leg orders
    // slither-disable-next-line reentrancy-no-eth
    function _processBuyLeg(BuyLegOrders memory buyLeg) internal {
        currentPhase = LiquidityUpkeepPhase.ProcessVaultOperations;

        for (uint16 i = 0; i < buyLeg.buyingTokens.length; ++i) {
            address token = buyLeg.buyingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = buyLeg.buyingAmounts[i];
            _executeBuy(token, amount, buyLeg.buyingEstimatedUnderlyingAmounts[i]);
        }

        _updateBufferAmount(deltaBufferAmount);
        deltaBufferAmount = 0;
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

    /// @notice Executes a sell order
    /// @param asset The asset to sell
    /// @param sharesAmount The amount of shares to sell
    /// @param estimatedUnderlyingAmount The estimated underlying amount to receive
    function _executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend shares
        IERC20(asset).forceApprove(address(adapter), sharesAmount);

        // Execute sell through adapter, pull shares from this contract and push underlying assets to it.
        uint256 executionUnderlyingAmount = adapter.sell(asset, sharesAmount, estimatedUnderlyingAmount);

        // Clean up approval
        IERC20(asset).forceApprove(address(adapter), 0);

        deltaBufferAmount += executionUnderlyingAmount.toInt256() - estimatedUnderlyingAmount.toInt256();
    }

    /// @notice Executes a buy order
    /// @param asset The asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    /// @dev The adapter handles slippage tolerance internally.
    function _executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) internal {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();

        // Approve adapter to spend underlying assets
        IERC20(underlyingAsset).forceApprove(
            address(adapter),
            estimatedUnderlyingAmount.mulDiv(BASIS_POINTS_FACTOR + slippageTolerance, BASIS_POINTS_FACTOR)
        );

        // Execute buy through adapter, pull underlying assets from this contract and push shares to it.
        uint256 executionUnderlyingAmount = adapter.buy(asset, sharesAmount, estimatedUnderlyingAmount);

        // Clean up approval
        IERC20(underlyingAsset).forceApprove(address(adapter), 0);

        deltaBufferAmount += estimatedUnderlyingAmount.toInt256() - executionUnderlyingAmount.toInt256();
    }

    /// @notice Handles the vault operations
    /// @param vaults The vault states
    /// @dev vaults[] shall match _currentEpoch.vaultsEpoch[] in order
    function _processVaultOperations(VaultState[] memory vaults) internal {
        address[] memory vaultsEpoch = _currentEpoch.vaultsEpoch;

        uint16 i0 = currentMinibatchIndex * minibatchSize;
        uint16 i1 = i0 + minibatchSize;
        ++currentMinibatchIndex;

        if (i1 > vaultsEpoch.length || i1 == vaultsEpoch.length) {
            i1 = uint16(vaultsEpoch.length);
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
            _nextUpdateTime = block.timestamp + epochDuration;
            emit EventsLib.EpochEnd(epochCounter);
            ++epochCounter;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address vaultAddress = vaultsEpoch[i];
            VaultState memory vaultState = vaults[i];

            _processSingleVaultOperations(
                vaultAddress,
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
    /// @param totalAssetsForDeposit The total assets for deposit operations
    /// @param totalAssetsForRedeem The total assets for redeem operations
    /// @param finalTotalAssets The final total assets for the vault
    /// @param managementFee The management fee to accrue
    /// @param performanceFee The performance fee to accrue
    /// @param tokens The portfolio token addresses
    /// @param shares The portfolio token number of shares
    function _processSingleVaultOperations(
        address vaultAddress,
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

        if (pendingRedeem > 0) {
            vaultContract.fulfillRedeem(totalAssetsForRedeem);
        }

        if (pendingDeposit > 0) {
            vaultContract.fulfillDeposit(totalAssetsForDeposit);
        }

        IOrionVault(vaultAddress).accrueVaultFees(managementFee, performanceFee);
        vaultContract.updateVaultState(tokens, shares, finalTotalAssets);

        if (config.isDecommissioningVault(vaultAddress)) {
            config.completeVaultDecommissioning(vaultAddress);
        }
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
