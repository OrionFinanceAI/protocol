// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategy } from "../interfaces/IOrionStrategy.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title KBestTvlWeightedAverageInvalid
 * @notice Test contract similar to KBestTvlWeightedAverage but without weight adjustment logic.
 *         This contract is designed to fail when submitting intent because weights may not sum to intentScale.
 * @author Orion Finance
 */
contract KBestTvlWeightedAverageInvalid is IOrionStrategy, Ownable, ERC165 {
    /// @notice The Orion configuration contract
    IOrionConfig public config;

    /// @notice The number of assets to pick
    uint16 public k;

    /// @notice Constructor for KBestTvlWeightedAverageInvalid strategy
    /// @param owner The owner of the contract
    /// @param _config The Orion configuration contract address
    /// @param _k The number of assets to pick
    constructor(address owner, address _config, uint16 _k) Ownable(owner) {
        if (_config == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(_config);
        k = _k;
    }

    /// @inheritdoc IOrionStrategy
    function submitIntent(IOrionTransparentVault vault) external {
        address[] memory vaultWhitelistedAssets = vault.vaultWhitelist();
        uint16 n = uint16(vaultWhitelistedAssets.length);
        uint256[] memory tvls = _getAssetTVLs(vaultWhitelistedAssets, n);

        uint16 kActual = uint16(Math.min(k, n));
        (address[] memory tokens, uint256[] memory topTvls) = _selectTopKAssets(
            vaultWhitelistedAssets,
            tvls,
            n,
            kActual
        );

        IOrionTransparentVault.IntentPosition[] memory intent = _calculatePositions(tokens, topTvls, kActual);
        vault.submitIntent(intent);
    }

    /// @notice Gets TVL for all whitelisted assets
    /// @param vaultWhitelistedAssets Array of whitelisted asset addresses
    /// @param n Number of assets
    /// @return tvls Array of TVL values
    function _getAssetTVLs(
        address[] memory vaultWhitelistedAssets,
        uint16 n
    ) internal view returns (uint256[] memory tvls) {
        tvls = new uint256[](n);

        for (uint16 i = 0; i < n; ++i) {
            try IERC4626(vaultWhitelistedAssets[i]).totalAssets() returns (uint256 tvl) {
                tvls[i] = tvl;
            } catch {
                tvls[i] = 1;
                // Set to dust amount to avoid bad filtering.
                // Dust-tolerant orchestration can handle this,
                // in case intent is not rounded at the vault level.
            }
        }
    }

    /// @notice Selects the top K assets based on TVL
    /// @param vaultWhitelistedAssets Array of whitelisted asset addresses
    /// @param tvls Array of TVL values
    /// @param n Total number of assets
    /// @param kActual Actual number of assets to select
    /// @return tokens Array of selected token addresses
    /// @return topTvls Array of TVL values for selected tokens
    function _selectTopKAssets(
        address[] memory vaultWhitelistedAssets,
        uint256[] memory tvls,
        uint16 n,
        uint16 kActual
    ) internal pure returns (address[] memory tokens, uint256[] memory topTvls) {
        tokens = new address[](kActual);
        topTvls = new uint256[](kActual);

        bool[] memory used = new bool[](n);
        for (uint16 idx = 0; idx < kActual; ++idx) {
            uint256 maxTVL = 0;
            uint256 maxIndex = 0;
            for (uint16 j = 0; j < n; ++j) {
                if (!used[j] && tvls[j] > maxTVL) {
                    maxTVL = tvls[j];
                    maxIndex = j;
                }
            }
            used[maxIndex] = true;
            tokens[idx] = vaultWhitelistedAssets[maxIndex];
            topTvls[idx] = tvls[maxIndex];
        }
    }

    /// @notice Calculates position allocations based on TVL weights
    /// @notice NOTE: This function intentionally does NOT adjust weights to sum to intentScale
    /// @param tokens Array of selected token addresses
    /// @param topTvls Array of TVL values for selected tokens
    /// @param kActual Actual number of assets to allocate
    /// @return intent Array of positions with calculated allocations
    function _calculatePositions(
        address[] memory tokens,
        uint256[] memory topTvls,
        uint16 kActual
    ) internal view returns (IOrionTransparentVault.IntentPosition[] memory intent) {
        uint256 totalTVL = 0;
        for (uint16 i = 0; i < kActual; ++i) {
            totalTVL += topTvls[i];
        }

        uint32 intentScale = uint32(10 ** config.curatorIntentDecimals());
        intent = new IOrionTransparentVault.IntentPosition[](kActual);

        // Calculate weights without adjustment - this may result in sumWeights < intentScale
        for (uint16 i = 0; i < kActual; ++i) {
            uint32 weight = uint32((topTvls[i] * intentScale) / totalTVL);
            intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: weight });
        }

        // Intentionally removed: weight adjustment logic that ensures sumWeights == intentScale
        // if (sumWeights < intentScale) {
        //     intent[0].weight += intentScale - sumWeights;
        // }
    }

    /// @notice Owner can update k
    /// @param kNew The new number of assets to pick
    function updateParameters(uint16 kNew) external onlyOwner {
        k = kNew;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165) returns (bool) {
        return interfaceId == type(IOrionStrategy).interfaceId || super.supportsInterface(interfaceId);
    }
}

