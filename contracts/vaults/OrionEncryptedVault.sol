// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint32, ebool, TFHE } from "fhevm/lib/TFHE.sol";
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

    function initialize(
        address curatorAddress,
        IOrionConfig configAddress,
        string calldata name,
        string calldata symbol
    ) public initializer {
        __OrionVault_init(curatorAddress, configAddress, name, symbol);
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit an encrypted portfolio intent.
    /// @param order EncryptedPosition struct containing the tokens and encrypted weights.
    /// @dev The weights are interpreted as percentage of total supply.
    function submitIntent(EncryptedPosition[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        // Clear previous intent by setting weights to zero
        euint32 ezero = TFHE.asEuint32(0);
        uint256 intentLength = _intentKeys.length;
        for (uint256 i = 0; i < intentLength; i++) {
            _intent[_intentKeys[i]] = ezero;
        }
        delete _intentKeys;

        euint32 totalWeight = ezero;
        uint256 orderLength = order.length;
        for (uint256 i = 0; i < orderLength; i++) {
            address token = order[i].token;
            euint32 weight = order[i].value;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);

            // Check for duplicate tokens in the order
            if (_seenTokens[token]) {
                revert ErrorsLib.TokenAlreadyInOrder(token);
            }
            _seenTokens[token] = true;

            ebool isWeightValid = TFHE.gt(weight, ezero);
            // TODO: Zama coprocessor to check isWeightValid == true, else
            // ErrorsLib.AmountMustBeGreaterThanZero(token);

            _intent[token] = weight;
            _intentKeys.push(token);
            totalWeight = TFHE.add(totalWeight, weight);
        }

        euint32 encryptedTotalWeight = TFHE.asEuint32(10 ** config.curatorIntentDecimals());
        ebool isTotalWeightValid = TFHE.eq(totalWeight, encryptedTotalWeight);
        // TODO: Zama coprocessor to check isTotalWeightValid, else
        // ErrorsLib.InvalidTotalWeight()

        // Clear temporary mapping
        for (uint256 i = 0; i < orderLength; i++) {
            delete _seenTokens[order[i].token];
        }

        emit EventsLib.OrderSubmitted(msg.sender);
    }

    // --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @notice Get the encrypted portfolio.
    /// @return tokens The tokens in the portfolio.
    /// @return sharesPerAsset The shares per asset in the portfolio.
    function getPortfolio() external view returns (address[] memory tokens, euint32[] memory sharesPerAsset) {
        uint256 length = _portfolioKeys.length;
        tokens = new address[](length);
        sharesPerAsset = new euint32[](length);
        for (uint256 i = 0; i < length; i++) {
            address token = _portfolioKeys[i];
            tokens[i] = token;
            sharesPerAsset[i] = _portfolio[token];
        }
    }

    function getIntent() external view returns (address[] memory tokens, euint32[] memory weights) {
        uint256 length = _intentKeys.length;
        tokens = new address[](length);
        weights = new euint32[](length);
        for (uint256 i = 0; i < length; i++) {
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
        euint32 ezero = TFHE.asEuint32(0);

        // Clear previous portfolio by setting weights to zero
        uint256 portfolioLength = _portfolioKeys.length;
        for (uint256 i = 0; i < portfolioLength; i++) {
            _portfolio[_portfolioKeys[i]] = ezero;
        }
        delete _portfolioKeys;

        // Update portfolio
        for (uint256 i = 0; i < portfolioLength; i++) {
            _portfolio[portfolio[i].token] = portfolio[i].value;
            _portfolioKeys.push(portfolio[i].token);
        }

        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }
}
