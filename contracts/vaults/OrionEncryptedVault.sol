// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { euint128, ebool, FHE } from "@fhevm/solidity/lib/FHE.sol";
import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

/**
 * @title OrionEncryptedVault
 * @notice A privacy-preserving implementation of OrionVault where strategist intents are submitted in encrypted form
 * @author Orion Finance
 * @dev
 * This implementation stores strategist intents as a mapping of token addresses to encrypted allocation percentages.
 * The intents are submitted and stored in encrypted form using FHEVM, making this suitable for use cases requiring
 * privacy of the portfolio allocation strategy, while maintaining capital efficiency.
 */
contract OrionEncryptedVault is ZamaEthereumConfig, OrionVault, IOrionEncryptedVault {
    /// @notice Current portfolio shares per asset (w_0) - mapping of token address to live allocation
    mapping(address => euint128) internal _portfolio;
    address[] internal _portfolioKeys;

    /// @notice Strategist intent (w_1) - mapping of token address to target allocation
    mapping(address => euint128) internal _intent;
    address[] internal _intentKeys;

    /// @notice Temporary mapping to track seen tokens during submitIntent to check for duplicates
    mapping(address => bool) internal _seenTokens;

    euint128 internal _ezero;
    ebool internal _eTrue;
    euint128 internal _encryptedTotalWeight;

    /// @notice Whether the intent is valid
    bool public isIntentValid;

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() ZamaEthereumConfig() {
        _disableInitializers();
    }

    /// @notice Initialize the vault
    /// @param manager_ The address of the vault manager
    /// @param strategist_ The address of the vault strategist
    /// @param config_ The address of the OrionConfig contract
    /// @param name_ The name of the vault
    /// @param symbol_ The symbol of the vault
    /// @param feeType_ The fee type
    /// @param performanceFee_ The performance fee
    /// @param managementFee_ The management fee
    /// @param depositAccessControl_ The address of the deposit access control contract (address(0) = permissionless)
    function initialize(
        address manager_,
        address strategist_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_,
        uint8 feeType_,
        uint16 performanceFee_,
        uint16 managementFee_,
        address depositAccessControl_
    ) public initializer {
        __OrionVault_init(
            manager_,
            strategist_,
            config_,
            name_,
            symbol_,
            feeType_,
            performanceFee_,
            managementFee_,
            depositAccessControl_
        );

        _ezero = FHE.asEuint128(0);
        _eTrue = FHE.asEbool(true);
        _encryptedTotalWeight = FHE.asEuint128(uint128(10 ** config.strategistIntentDecimals()));
        // slither-disable-next-line unused-return
        FHE.allowThis(_ezero);
        // slither-disable-next-line unused-return
        FHE.allowThis(_eTrue);
        // slither-disable-next-line unused-return
        FHE.allowThis(_encryptedTotalWeight);

        // Initial intent: 100% underlying asset
        _intent[address(config.underlyingAsset())] = _encryptedTotalWeight;
        _intentKeys.push(address(config.underlyingAsset()));
    }

    /// --------- STRATEGIST FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function submitIntent(
        EncryptedIntent[] calldata intent,
        bytes calldata inputProof
    ) external onlyStrategist nonReentrant {
        if (intent.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        isIntentValid = false; // Reset intent validity flag, asynchronous callback can update it.

        uint16 intentLength = uint16(intent.length);
        euint128 totalWeight = _ezero;

        address[] memory tempKeys = new address[](intentLength);
        euint128[] memory tempWeights = new euint128[](intentLength);

        address[] memory assets = new address[](intentLength);
        for (uint16 i = 0; i < intentLength; ++i) {
            address token = intent[i].token;
            assets[i] = token;

            euint128 weight = FHE.fromExternal(intent[i].weight, inputProof);
            // slither-disable-next-line unused-return
            FHE.allowThis(weight);

            if (_seenTokens[token]) revert ErrorsLib.TokenAlreadyInOrder(token);

            _seenTokens[token] = true;
            tempKeys[i] = token;
            tempWeights[i] = weight;
            totalWeight = FHE.add(totalWeight, weight);
        }

        _validateIntent(assets, totalWeight);

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
    }

    /// @notice Validates the intent
    /// @param assets The assets in the intent
    /// @param totalWeight The total weight of the intent
    function _validateIntent(address[] memory assets, euint128 totalWeight) internal {
        _validateIntentAssets(assets);

        ebool isIntentEValid = FHE.eq(totalWeight, _encryptedTotalWeight);

        // slither-disable-next-line unused-return
        FHE.allowThis(isIntentEValid);

        bytes32[] memory cipherTexts = new bytes32[](1);
        cipherTexts[0] = FHE.toBytes32(isIntentEValid);
    }

    // --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function getPortfolio() external view returns (address[] memory tokens, euint128[] memory sharesPerAsset) {
        uint16 length = uint16(_portfolioKeys.length);
        tokens = new address[](length);
        sharesPerAsset = new euint128[](length);
        for (uint16 i = 0; i < length; ++i) {
            address token = _portfolioKeys[i];
            tokens[i] = token;
            sharesPerAsset[i] = _portfolio[token];
        }
    }

    /// @inheritdoc IOrionEncryptedVault
    function getIntent() external view returns (address[] memory tokens, euint128[] memory weights) {
        if (isDecommissioning) {
            tokens = new address[](1);
            weights = new euint128[](1);
            tokens[0] = address(config.underlyingAsset());
            weights[0] = _encryptedTotalWeight;
        } else {
            uint16 length = uint16(_intentKeys.length);
            tokens = new address[](length);
            weights = new euint128[](length);
            for (uint16 i = 0; i < length; ++i) {
                tokens[i] = _intentKeys[i];
                weights[i] = _intent[_intentKeys[i]];
            }
        }
    }

    /// @inheritdoc IOrionEncryptedVault
    function updateVaultState(
        address[] calldata tokens,
        euint128[] calldata shares,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        // Clear previous portfolio by setting weights to zero
        uint16 portfolioLength = uint16(_portfolioKeys.length);
        for (uint16 i = 0; i < portfolioLength; ++i) {
            _portfolio[_portfolioKeys[i]] = _ezero;
        }
        delete _portfolioKeys;

        // Update portfolio
        uint16 newPortfolioLength = uint16(tokens.length);
        for (uint16 i = 0; i < newPortfolioLength; ++i) {
            _portfolio[tokens[i]] = shares[i];
            _portfolioKeys.push(tokens[i]);
        }

        _totalAssets = newTotalAssets;

        uint256 currentSharePrice = convertToAssets(10 ** decimals());

        if (currentSharePrice > feeModel.highWaterMark) {
            feeModel.highWaterMark = currentSharePrice;
        }
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
