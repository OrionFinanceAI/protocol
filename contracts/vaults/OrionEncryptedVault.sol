// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { euint32, ebool, FHE } from "@fhevm/solidity/lib/FHE.sol";
import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionEncryptedVault
 * @notice A privacy-preserving implementation of OrionVault where curator intents are submitted in encrypted form
 * @author Orion Finance
 * @dev
 * This implementation stores curator intents as a mapping of token addresses to encrypted allocation percentages.
 * The intents are submitted and stored in encrypted form using FHEVM, making this suitable for use cases requiring
 * privacy of the portfolio allocation strategy, while maintaining capital efficiency.
 */
contract OrionEncryptedVault is SepoliaConfig, OrionVault, IOrionEncryptedVault {
    /// @notice Current portfolio shares per asset (w_0) - mapping of token address to live allocation
    mapping(address => euint32) internal _portfolio;
    address[] internal _portfolioKeys;

    /// @notice Curator intent (w_1) - mapping of token address to target allocation
    mapping(address => euint32) internal _intent;
    address[] internal _intentKeys;

    /// @notice Temporary mapping to track seen tokens during submitIntent to check for duplicates
    mapping(address => bool) internal _seenTokens;

    euint32 internal _ezero;
    ebool internal _eTrue;
    euint32 internal _encryptedTotalWeight;

    /// @notice Whether the intent is valid
    bool public isIntentValid;

    /// @notice Constructor
    /// @param vaultOwner The address of the vault owner
    /// @param curator The address of the vault curator
    /// @param configAddress The address of the OrionConfig contract
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    constructor(
        address vaultOwner,
        address curator,
        IOrionConfig configAddress,
        string memory name,
        string memory symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee
    ) OrionVault(vaultOwner, curator, configAddress, name, symbol, feeType, performanceFee, managementFee) {
        _ezero = FHE.asEuint32(0);
        _eTrue = FHE.asEbool(true);
        _encryptedTotalWeight = FHE.asEuint32(uint32(10 ** curatorIntentDecimals));
        // slither-disable-next-line unused-return
        FHE.allowThis(_ezero);
        // slither-disable-next-line unused-return
        FHE.allowThis(_eTrue);
        // slither-disable-next-line unused-return
        FHE.allowThis(_encryptedTotalWeight);
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function submitIntent(
        EncryptedIntent[] calldata intent,
        bytes calldata inputProof
    ) external onlyCurator nonReentrant {
        if (intent.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        isIntentValid = false; // Reset intent validity flag, asynchronous callback can update it.

        uint16 intentLength = uint16(intent.length);
        euint32 totalWeight = _ezero;

        address[] memory tempKeys = new address[](intentLength);
        euint32[] memory tempWeights = new euint32[](intentLength);

        ebool areWeightsValid = _eTrue;
        address[] memory assets = new address[](intentLength);
        for (uint16 i = 0; i < intentLength; ++i) {
            address token = intent[i].token;
            assets[i] = token;

            euint32 weight = FHE.fromExternal(intent[i].weight, inputProof);
            // slither-disable-next-line unused-return
            FHE.allowThis(weight);

            ebool isWeightValid = FHE.gt(weight, _ezero);
            areWeightsValid = FHE.and(areWeightsValid, isWeightValid);

            if (_seenTokens[token]) revert ErrorsLib.TokenAlreadyInOrder(token);

            _seenTokens[token] = true;
            tempKeys[i] = token;
            tempWeights[i] = weight;
            totalWeight = FHE.add(totalWeight, weight);
        }

        _validateIntent(assets, totalWeight, areWeightsValid);

        // Clear previous intent by setting weights to zero (state write after all external calls)
        for (uint16 i = 0; i < uint16(_intentKeys.length); ++i) {
            _intent[_intentKeys[i]] = _ezero;
        }
        delete _intentKeys;

        for (uint16 i = 0; i < intentLength; ++i) {
            address token = tempKeys[i];
            _intent[token] = tempWeights[i];
            _intentKeys.push(token);
            delete _seenTokens[token];
        }

        emit EventsLib.OrderSubmitted(msg.sender);
    }

    /// @notice Validates the intent
    /// @param assets The assets in the intent
    /// @param totalWeight The total weight of the intent
    /// @param areWeightsValid Whether the weights are valid
    function _validateIntent(address[] memory assets, euint32 totalWeight, ebool areWeightsValid) internal {
        _validateIntentAssets(assets);

        ebool isIntentEValid = FHE.and(areWeightsValid, FHE.eq(totalWeight, _encryptedTotalWeight));

        // slither-disable-next-line unused-return
        FHE.allowThis(isIntentEValid);

        bytes32[] memory cypherTexts = new bytes32[](1);
        cypherTexts[0] = FHE.toBytes32(isIntentEValid);

        // slither-disable-next-line unused-return
        FHE.requestDecryption(cypherTexts, this.callbackDecryptSingleEbool.selector);
    }

    // --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function getPortfolio() external view returns (address[] memory tokens, euint32[] memory sharesPerAsset) {
        uint16 length = uint16(_portfolioKeys.length);
        tokens = new address[](length);
        sharesPerAsset = new euint32[](length);
        for (uint16 i = 0; i < length; ++i) {
            address token = _portfolioKeys[i];
            tokens[i] = token;
            sharesPerAsset[i] = _portfolio[token];
        }
    }

    /// @inheritdoc IOrionEncryptedVault
    function getIntent() external view returns (address[] memory tokens, euint32[] memory weights) {
        uint16 length = uint16(_intentKeys.length);
        tokens = new address[](length);
        weights = new euint32[](length);
        for (uint16 i = 0; i < length; ++i) {
            tokens[i] = _intentKeys[i];
            weights[i] = _intent[_intentKeys[i]];
        }
    }

    // --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function updateVaultState(
        EncryptedPortfolio[] calldata portfolio,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        // Clear previous portfolio by setting weights to zero
        uint16 portfolioLength = uint16(_portfolioKeys.length);
        for (uint16 i = 0; i < portfolioLength; ++i) {
            _portfolio[_portfolioKeys[i]] = _ezero;
        }
        delete _portfolioKeys;

        // Update portfolio
        for (uint16 i = 0; i < portfolioLength; ++i) {
            _portfolio[portfolio[i].token] = portfolio[i].value;
            _portfolioKeys.push(portfolio[i].token);
        }

        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }

    // --------- ZAMA COPROCESSOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function callbackDecryptSingleEbool(uint256 requestID, bool decryptedInput, bytes[] calldata signatures) external {
        FHE.checkSignatures(requestID, signatures);
        isIntentValid = decryptedInput;
    }
}
