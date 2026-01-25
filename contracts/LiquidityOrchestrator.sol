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

    /// @notice Pending protocol fees [assets]
    uint256 public pendingProtocolFees;

    /// @notice Struct to hold epoch state data
    struct EpochState {
        /// @notice Delta buffer amount for current epoch [assets]
        int256 deltaBufferAmount;
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
        /// @notice Underlying asset address
        address underlyingAssetSnapshot;
        /// @notice Underlying asset decimals
        uint8 underlyingDecimals;
        /// @notice Price adapter decimals
        uint8 priceAdapterDecimals;
        /// @notice Strategist intent decimals
        uint8 strategistIntentDecimals;
        /// @notice Epoch duration
        uint32 epochDurationSnapshot;
        /// @notice Token decimals for each asset
        mapping(address => uint8) tokenDecimals;
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
        slippageTolerance = _targetBufferRatio / 2;
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
    function getEpochState() external view returns (ILiquidityOrchestrator.EpochStateView memory) {
        address[] memory assets = config.getAllWhitelistedAssets();
        uint256[] memory assetPrices = _getAssetPrices(assets);
        address[] memory vaults = _currentEpoch.vaultsEpoch;

        // Build vault fee models array
        IOrionVault.FeeModel[] memory vaultFeeModels = new IOrionVault.FeeModel[](vaults.length);
        for (uint16 i = 0; i < vaults.length; ++i) {
            vaultFeeModels[i] = _currentEpoch.feeModel[vaults[i]];
        }

        uint8[] memory assetTokenDecimals = new uint8[](assets.length);
        for (uint16 i = 0; i < assets.length; ++i) {
            assetTokenDecimals[i] = _currentEpoch.tokenDecimals[assets[i]];
        }

        return
            ILiquidityOrchestrator.EpochStateView({
                deltaBufferAmount: _currentEpoch.deltaBufferAmount,
                vaultsEpoch: vaults,
                assets: assets,
                assetPrices: assetPrices,
                tokenDecimals: assetTokenDecimals,
                activeVFeeCoefficient: _currentEpoch.activeVFeeCoefficient,
                activeRsFeeCoefficient: _currentEpoch.activeRsFeeCoefficient,
                vaultAddresses: vaults,
                vaultFeeModels: vaultFeeModels,
                epochStateCommitment: _currentEpoch.epochStateCommitment,
                underlyingAsset: _currentEpoch.underlyingAssetSnapshot,
                underlyingDecimals: _currentEpoch.underlyingDecimals,
                priceAdapterDecimals: _currentEpoch.priceAdapterDecimals,
                strategistIntentDecimals: _currentEpoch.strategistIntentDecimals,
                epochDuration: _currentEpoch.epochDurationSnapshot
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
    function pause() external onlyConfig {
        _pause();
    }

    /// @inheritdoc ILiquidityOrchestrator
    function unpause() external onlyConfig {
        _unpause();
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

    /// @notice Checks if the upkeep is needed
    /// @dev https://docs.chain.link/chainlink-automation/reference/automation-interfaces
    /// @return upkeepNeeded Whether the upkeep is needed
    /// @return performData Empty bytes
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
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
        performData = "";
    }

    /// @notice Performs the upkeep
    /// @param performData Encoded data containing (_publicValues, _proofBytes, _statesBytes)
    function performUpkeep(
        bytes calldata performData
    ) external override onlyAuthorizedTrigger nonReentrant whenNotPaused {
        if (currentPhase == LiquidityUpkeepPhase.Idle && _shouldTriggerUpkeep()) {
            _handleStart();
        } else if (currentPhase == LiquidityUpkeepPhase.StateCommitment) {
            _currentEpoch.epochStateCommitment = _buildEpochStateCommitment();
            currentPhase = LiquidityUpkeepPhase.SellingLeg;
        } else if (currentPhase == LiquidityUpkeepPhase.SellingLeg) {
            StatesStruct memory states = _verifyPerformData(performData);
            _processSellLeg(states);
        } else if (currentPhase == LiquidityUpkeepPhase.BuyingLeg) {
            StatesStruct memory states = _verifyPerformData(performData);
            _processBuyLeg(states);
        } else if (currentPhase == LiquidityUpkeepPhase.ProcessVaultOperations) {
            StatesStruct memory states = _verifyPerformData(performData);
            _processVaultOperations(states);
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
                address vault = _currentEpoch.vaultsEpoch[i];
                IOrionVault.FeeModel memory feeModel = IOrionVault(vault).activeFeeModel();
                _currentEpoch.feeModel[vault] = feeModel;
            }

            _currentEpoch.underlyingAssetSnapshot = underlyingAsset;
            _currentEpoch.underlyingDecimals = IERC20Metadata(underlyingAsset).decimals();
            _currentEpoch.priceAdapterDecimals = config.priceAdapterDecimals();
            _currentEpoch.strategistIntentDecimals = config.strategistIntentDecimals();
            _currentEpoch.epochDurationSnapshot = epochDuration;

            address[] memory assets = config.getAllWhitelistedAssets();
            for (uint16 i = 0; i < assets.length; ++i) {
                _currentEpoch.pricesEpoch[assets[i]] = priceAdapterRegistry.getPrice(assets[i]);
                _currentEpoch.tokenDecimals[assets[i]] = IERC20Metadata(assets[i]).decimals();
            }

            emit EventsLib.EpochStart(epochCounter);
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
    /// @return The epoch state commitment
    function _buildEpochStateCommitment() internal view returns (bytes32) {
        address[] memory assets = config.getAllWhitelistedAssets();
        uint256[] memory assetPrices = _getAssetPrices(assets);
        address[] memory vaults = _currentEpoch.vaultsEpoch;
        VaultStateData memory vaultData = _getVaultStateData(vaults);

        bytes32 protocolStateHash = _buildProtocolStateHash();
        bytes32 assetsHash = _aggregateAssetLeaves(assets, assetPrices);
        bytes32 vaultsHash = _aggregateVaultLeaves(vaults, vaultData);
        return keccak256(abi.encode(protocolStateHash, assetsHash, vaultsHash));
    }

    /// @notice Builds the protocol state hash from static epoch parameters
    /// @return The protocol state hash
    function _buildProtocolStateHash() internal view returns (bytes32) {
        address[] memory assets = config.getAllWhitelistedAssets();
        uint8[] memory assetTokenDecimals = new uint8[](assets.length);
        for (uint16 i = 0; i < assets.length; ++i) {
            assetTokenDecimals[i] = _currentEpoch.tokenDecimals[assets[i]];
        }

        return
            keccak256(
                abi.encode(
                    _currentEpoch.activeVFeeCoefficient,
                    _currentEpoch.activeRsFeeCoefficient,
                    _currentEpoch.deltaBufferAmount,
                    config.maxFulfillBatchSize(),
                    targetBufferRatio,
                    bufferAmount,
                    _currentEpoch.underlyingAssetSnapshot,
                    _currentEpoch.underlyingDecimals,
                    _currentEpoch.priceAdapterDecimals,
                    _currentEpoch.strategistIntentDecimals,
                    _currentEpoch.epochDurationSnapshot,
                    assets,
                    assetTokenDecimals
                )
            );
    }

    /// @notice Computes the leaf hash for a single asset
    /// @param assetAddress The address of the asset
    /// @param assetPrice The price of the asset
    /// @return The asset leaf hash
    function _computeAssetLeaf(address assetAddress, uint256 assetPrice) internal pure returns (bytes32) {
        return keccak256(abi.encode(assetAddress, assetPrice));
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
            bytes32 assetLeaf = _computeAssetLeaf(assets[i], assetPrices[i]);
            assetsHash = keccak256(abi.encode(assetsHash, assetLeaf));
        }
        return assetsHash;
    }

    /// @notice Computes the portfolio hash for a vault
    /// @param portfolioTokens Array of portfolio token addresses
    /// @param portfolioShares Array of portfolio token shares
    /// @return The portfolio hash
    function _computePortfolioHash(
        address[] memory portfolioTokens,
        uint256[] memory portfolioShares
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(portfolioTokens, portfolioShares));
    }

    /// @notice Computes the intent hash for a vault
    /// @param intentTokens Array of intent token addresses
    /// @param intentWeights Array of intent token weights
    /// @return The intent hash
    function _computeIntentHash(
        address[] memory intentTokens,
        uint32[] memory intentWeights
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(intentTokens, intentWeights));
    }

    /// @notice Computes the leaf hash for a single vault
    /// @param vaultAddress The address of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @param highWaterMark The high water mark
    /// @param pendingRedeem The pending redeem amount
    /// @param pendingDeposit The pending deposit amount
    /// @param portfolioHash The portfolio hash
    /// @param intentHash The intent hash
    /// @return The vault leaf hash
    function _computeVaultLeaf(
        address vaultAddress,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee,
        uint256 highWaterMark,
        uint256 pendingRedeem,
        uint256 pendingDeposit,
        bytes32 portfolioHash,
        bytes32 intentHash
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    vaultAddress,
                    feeType,
                    performanceFee,
                    managementFee,
                    highWaterMark,
                    pendingRedeem,
                    pendingDeposit,
                    portfolioHash,
                    intentHash
                )
            );
    }

    /// @notice Aggregates vault leaves using sequential folding
    /// @param vaults Array of vault addresses
    /// @param vaultData Struct containing all vault state data
    /// @return The aggregated vaults hash
    function _aggregateVaultLeaves(
        address[] memory vaults,
        VaultStateData memory vaultData
    ) internal pure returns (bytes32) {
        bytes32 vaultsHash = bytes32(0);
        for (uint16 i = 0; i < vaults.length; ++i) {
            bytes32 portfolioHash = _computePortfolioHash(vaultData.portfolioTokens[i], vaultData.portfolioShares[i]);

            bytes32 intentHash = _computeIntentHash(vaultData.intentTokens[i], vaultData.intentWeights[i]);

            bytes32 vaultLeaf = _computeVaultLeaf(
                vaults[i],
                vaultData.feeTypes[i],
                vaultData.performanceFees[i],
                vaultData.managementFees[i],
                vaultData.highWaterMarks[i],
                vaultData.pendingRedeems[i],
                vaultData.pendingDeposits[i],
                portfolioHash,
                intentHash
            );

            // Fold into aggregate
            vaultsHash = keccak256(abi.encode(vaultsHash, vaultLeaf));
        }
        return vaultsHash;
    }

    /// @notice Gets asset prices for the epoch
    /// @param assets Array of asset addresses
    /// @return assetPrices Array of asset prices
    function _getAssetPrices(address[] memory assets) internal view returns (uint256[] memory assetPrices) {
        assetPrices = new uint256[](assets.length);
        for (uint16 i = 0; i < assets.length; ++i) {
            assetPrices[i] = _currentEpoch.pricesEpoch[assets[i]];
        }
    }

    /// @notice Gets vault state data for all vaults in the epoch
    /// @param vaults Array of vault addresses
    /// @return vaultData Struct containing all vault state data
    function _getVaultStateData(address[] memory vaults) internal view returns (VaultStateData memory vaultData) {
        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        uint16 vaultCount = uint16(vaults.length);

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
            IOrionTransparentVault vault = IOrionTransparentVault(vaults[i]);
            IOrionVault.FeeModel memory feeModel = _currentEpoch.feeModel[vaults[i]];

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
    /// @param performData The perform data
    /// @return states The states
    function _verifyPerformData(bytes calldata performData) internal view returns (StatesStruct memory states) {
        PerformDataStruct memory performDataStruct = abi.decode(performData, (PerformDataStruct));
        bytes memory _publicValues = performDataStruct._publicValues;
        PublicValuesStruct memory publicValues = abi.decode(_publicValues, (PublicValuesStruct));

        // Verify that the proof's input commitment matches the onchain input commitment
        if (publicValues.inputCommitment != _currentEpoch.epochStateCommitment) {
            revert ErrorsLib.CommitmentMismatch(publicValues.inputCommitment, _currentEpoch.epochStateCommitment);
        }

        states = performDataStruct.states;

        // Verify that the computed output commitment matches the one in public values
        bytes32 outputCommitment = keccak256(abi.encode(states));
        if (publicValues.outputCommitment != outputCommitment) {
            revert ErrorsLib.CommitmentMismatch(publicValues.outputCommitment, outputCommitment);
        }

        bytes memory proofBytes = performDataStruct.proofBytes;

        verifier.verifyProof(vKey, _publicValues, proofBytes);
    }

    /// @notice Handles the sell action
    function _processSellLeg(StatesStruct memory states) internal {
        (
            address[] memory sellingTokens,
            uint256[] memory sellingAmounts,
            uint256[] memory sellingEstimatedUnderlyingAmounts
        ) = (new address[](0), new uint256[](0), new uint256[](0)); // TODO: implement getOrders(true);

        currentPhase = LiquidityUpkeepPhase.BuyingLeg;

        for (uint16 i = 0; i < sellingTokens.length; ++i) {
            address token = sellingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = sellingAmounts[i];
            _executeSell(token, amount, sellingEstimatedUnderlyingAmounts[i]);
        }
    }

    /// @notice Handles the buy action
    // slither-disable-next-line reentrancy-no-eth
    function _processBuyLeg(StatesStruct memory states) internal {
        address[] memory buyingTokens = new address[](0);
        uint256[] memory buyingAmounts = new uint256[](0);
        uint256[] memory buyingEstimatedUnderlyingAmounts = new uint256[](0);
        // TODO: implement getOrders(false);

        currentPhase = LiquidityUpkeepPhase.ProcessVaultOperations;

        for (uint16 i = 0; i < buyingTokens.length; ++i) {
            address token = buyingTokens[i];
            if (token == address(underlyingAsset)) continue;
            uint256 amount = buyingAmounts[i];
            _executeBuy(token, amount, buyingEstimatedUnderlyingAmounts[i]);
        }

        _updateBufferAmount(_currentEpoch.deltaBufferAmount);
        _currentEpoch.deltaBufferAmount = 0;
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

        _currentEpoch.deltaBufferAmount += executionUnderlyingAmount.toInt256() - estimatedUnderlyingAmount.toInt256();
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

        _currentEpoch.deltaBufferAmount += estimatedUnderlyingAmount.toInt256() - executionUnderlyingAmount.toInt256();
    }

    /// @notice Handles the vault operations
    function _processVaultOperations(StatesStruct memory states) internal {
        // Process transparent vaults
        address[] memory transparentVaults = config.getAllOrionVaults(EventsLib.VaultType.Transparent);

        uint16 i0 = currentMinibatchIndex * minibatchSize;
        uint16 i1 = i0 + minibatchSize;
        ++currentMinibatchIndex;

        if (i1 > transparentVaults.length || i1 == transparentVaults.length) {
            i1 = uint16(transparentVaults.length);
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
            _nextUpdateTime = block.timestamp + epochDuration;
            emit EventsLib.EpochEnd(epochCounter);
            ++epochCounter;
        }

        for (uint16 i = i0; i < i1; ++i) {
            address vault = transparentVaults[i];
            (uint256 totalAssetsForRedeem, uint256 totalAssetsForDeposit, uint256 finalTotalAssets) = (0, 0, 0);
            // TODO: implement getVaultTotalAssetsAll(vault);

            _processSingleVaultOperations(vault, totalAssetsForDeposit, totalAssetsForRedeem, finalTotalAssets);
        }
    }

    /// @notice Processes deposit and redeem operations for a single vault
    /// @param vault The vault address
    /// @param totalAssetsForDeposit The total assets for deposit operations
    /// @param totalAssetsForRedeem The total assets for redeem operations
    /// @param finalTotalAssets The final total assets for the vault
    function _processSingleVaultOperations(
        address vault,
        uint256 totalAssetsForDeposit,
        uint256 totalAssetsForRedeem,
        uint256 finalTotalAssets
    ) internal {
        IOrionTransparentVault vaultContract = IOrionTransparentVault(vault);

        uint256 maxFulfillBatchSize = config.maxFulfillBatchSize();
        uint256 pendingRedeem = vaultContract.pendingRedeem(maxFulfillBatchSize);
        uint256 pendingDeposit = vaultContract.pendingDeposit(maxFulfillBatchSize);

        if (pendingRedeem > 0) {
            vaultContract.fulfillRedeem(totalAssetsForRedeem);
        }

        if (pendingDeposit > 0) {
            vaultContract.fulfillDeposit(totalAssetsForDeposit);
        }

        (uint256 managementFee, uint256 performanceFee) = (0, 0); // TODO: implement getVaultFee(vault);
        IOrionVault(vault).accrueVaultFees(managementFee, performanceFee);

        address[] memory tokens = new address[](0);
        uint256[] memory shares = new uint256[](0);
        // TODO: implement getVaultPortfolio(vault);
        vaultContract.updateVaultState(tokens, shares, finalTotalAssets);

        if (config.isDecommissioningVault(vault)) {
            for (uint16 i = 0; i < tokens.length; ++i) {
                if (tokens[i] == address(underlyingAsset)) {
                    if (shares[i] == finalTotalAssets) {
                        config.completeVaultDecommissioning(vault);
                        break;
                    }
                }
            }
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
