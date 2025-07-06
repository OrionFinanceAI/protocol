// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint32, TFHE } from "fhevm/lib/TFHE.sol";
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
    function submitIntent(EncryptedPosition[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        // Clear previous intent by setting weights to zero
        euint32 ezero = TFHE.asEuint32(0);
        uint256 intentLength = _intentKeys.length;
        for (uint256 i = 0; i < intentLength; i++) {
            _intent[_intentKeys[i]] = ezero;
        }
        delete _intentKeys;

        uint256 orderLength = order.length;
        for (uint256 i = 0; i < orderLength; i++) {
            address token = order[i].token;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            _intent[token] = order[i].weight;
            _intentKeys.push(token);
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

    // TODO: Get the encrypted sharesPerAsset executed by the liquidity orchestrator
    // and update the vault intent with an encrypted calibration error before storing it.
    /// @notice Update vault state based on market performance and pending operations
    /// @param portfolio The new portfolio after processing pending transactions.
    /// @param newTotalAssets The new total assets after processing pending transactions.
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
            _portfolio[portfolio[i].token] = portfolio[i].weight;
            _portfolioKeys.push(portfolio[i].token);
        }

        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }
}
