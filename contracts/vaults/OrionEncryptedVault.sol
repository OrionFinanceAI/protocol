// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint32, ebool, FHE } from "@fhevm/solidity/lib/FHE.sol";
import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionEncryptedVault
 * @notice A privacy-preserving implementation of OrionVault where curator intents are submitted in encrypted form
 * @dev
 * This implementation stores curator intents as a mapping of token addresses to encrypted allocation percentages.
 * The intents are submitted and stored in encrypted form using FHEVM, making this suitable for use cases requiring
 * privacy of the portfolio allocation strategy, while maintaining capital efficiency.
 */
contract OrionEncryptedVault is OrionVault, IOrionEncryptedVault {
    /// @notice Current portfolio shares per asset (w_0) - mapping of token address to live allocation
    mapping(address => euint32) internal _portfolio;
    address[] internal _portfolioKeys;

    /// @notice Curator intent (w_1) - mapping of token address to target allocation
    mapping(address => euint32) internal _intent;
    address[] internal _intentKeys;

    /// @notice Temporary mapping to track seen tokens during submitIntent to check for duplicates
    mapping(address => bool) internal _seenTokens;

    euint32 internal _ezero;

    constructor(
        address vaultOwner,
        address curator,
        IOrionConfig configAddress,
        string memory name,
        string memory symbol
    ) OrionVault(vaultOwner, curator, configAddress, name, symbol) {
        _ezero = FHE.asEuint32(0);
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function submitIntent(EncryptedPosition[] calldata order) external onlyCurator nonReentrant {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        uint16 orderLength = uint16(order.length);
        euint32 totalWeight = _ezero;

        address[] memory tempKeys = new address[](orderLength);
        euint32[] memory tempWeights = new euint32[](orderLength);

        for (uint16 i = 0; i < orderLength; i++) {
            address token = order[i].token;
            euint32 weight = order[i].value;

            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);

            // TODO: Additional check:
            // https://docs.zama.ai/protocol/solidity-guides/smart-contract/inputs#validating-encrypted-inputs

            // TODO: Zama coprocessor to check isWeightValid == true, else
            // ebool isWeightValid = FHE.gt(weight, ezero);
            // ErrorsLib.AmountMustBeGreaterThanZero(token);

            if (_seenTokens[token]) revert ErrorsLib.TokenAlreadyInOrder(token);

            _seenTokens[token] = true;
            tempKeys[i] = token;
            tempWeights[i] = weight;
            totalWeight = FHE.add(totalWeight, weight);
        }
        euint32 encryptedTotalWeight = FHE.asEuint32(uint32(10 ** config.curatorIntentDecimals()));
        ebool isTotalWeightValid = FHE.eq(totalWeight, encryptedTotalWeight);
        // TODO: Zama coprocessor to check isTotalWeightValid
        // bytes32[] memory cts = new bytes32[](1);
        // cts[0] = FHE.toBytes32(isTotalWeightValid);
        // https://docs.zama.ai/protocol/solidity-guides/smart-contract/oracle#overview
        // else
        // ErrorsLib.InvalidTotalWeight()

        // Clear previous intent by setting weights to zero (state write after all external calls)
        uint16 intentLength = uint16(_intentKeys.length);
        for (uint16 i = 0; i < intentLength; i++) {
            _intent[_intentKeys[i]] = _ezero;
        }
        delete _intentKeys;

        for (uint16 i = 0; i < orderLength; i++) {
            address token = tempKeys[i];
            _intent[token] = tempWeights[i];
            _intentKeys.push(token);
            delete _seenTokens[token];
        }

        emit EventsLib.OrderSubmitted(msg.sender);
    }

    // --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function getPortfolio() external view returns (address[] memory tokens, euint32[] memory sharesPerAsset) {
        uint16 length = uint16(_portfolioKeys.length);
        tokens = new address[](length);
        sharesPerAsset = new euint32[](length);
        for (uint16 i = 0; i < length; i++) {
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
        for (uint16 i = 0; i < length; i++) {
            tokens[i] = _intentKeys[i];
            weights[i] = _intent[_intentKeys[i]];
        }
    }

    // --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function updateVaultState(
        EncryptedPosition[] calldata portfolio,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        // Clear previous portfolio by setting weights to zero
        uint16 portfolioLength = uint16(_portfolioKeys.length);
        for (uint16 i = 0; i < portfolioLength; i++) {
            _portfolio[_portfolioKeys[i]] = _ezero;
        }
        delete _portfolioKeys;

        // Update portfolio
        for (uint16 i = 0; i < portfolioLength; i++) {
            _portfolio[portfolio[i].token] = portfolio[i].value;
            _portfolioKeys.push(portfolio[i].token);
        }

        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }
}
