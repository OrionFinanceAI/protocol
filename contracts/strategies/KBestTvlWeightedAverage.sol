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
 * @title KBestTvlWeightedAverage
 * @notice This strategy selects the top K assets based on their TVL and allocates them proportionally.
 * @author Orion Finance
 */
contract KBestTvlWeightedAverage is IOrionStrategy, Ownable, ERC165 {
    /// @notice The Orion configuration contract
    IOrionConfig public config;

    /// @notice The number of assets to pick
    uint8 public k;

    /// @notice Constructor for KBestTvlWeightedAverage strategy
    /// @param owner The owner of the contract
    /// @param _config The Orion configuration contract address
    /// @param _k The number of assets to pick
    constructor(address owner, address _config, uint8 _k) Ownable(owner) {
        if (_config == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(_config);
        k = _k;
    }

    /// @inheritdoc IOrionStrategy
    function computeIntent(
        address[] calldata vaultWhitelistedAssets
    ) external view returns (IOrionTransparentVault.Position[] memory intent) {
        uint8 n = uint8(vaultWhitelistedAssets.length);
        uint256[] memory tvls = _getAssetTVLs(vaultWhitelistedAssets, n);

        uint8 kActual = uint8(Math.min(k, n));
        (address[] memory tokens, uint256[] memory topTvls) = _selectTopKAssets(
            vaultWhitelistedAssets,
            tvls,
            n,
            kActual
        );

        intent = _calculatePositions(tokens, topTvls, kActual);
    }

    /// @notice Gets TVL for all whitelisted assets
    /// @param vaultWhitelistedAssets Array of whitelisted asset addresses
    /// @param n Number of assets
    /// @return tvls Array of TVL values
    function _getAssetTVLs(
        address[] calldata vaultWhitelistedAssets,
        uint8 n
    ) internal view returns (uint256[] memory tvls) {
        tvls = new uint256[](n);

        for (uint8 i = 0; i < n; ++i) {
            // This tvl measurement is limited to assets which are ERC4626 compliant and
            // whose underlying has the same decimals.
            tvls[i] = IERC4626(vaultWhitelistedAssets[i]).totalAssets();
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
        address[] calldata vaultWhitelistedAssets,
        uint256[] memory tvls,
        uint8 n,
        uint8 kActual
    ) internal pure returns (address[] memory tokens, uint256[] memory topTvls) {
        tokens = new address[](kActual);
        topTvls = new uint256[](kActual);

        bool[] memory used = new bool[](n);
        for (uint8 idx = 0; idx < kActual; ++idx) {
            uint256 maxTVL = 0;
            uint256 maxIndex = 0;
            for (uint8 j = 0; j < n; ++j) {
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
    /// @param tokens Array of selected token addresses
    /// @param topTvls Array of TVL values for selected tokens
    /// @param kActual Actual number of assets to allocate
    /// @return intent Array of positions with calculated allocations
    function _calculatePositions(
        address[] memory tokens,
        uint256[] memory topTvls,
        uint8 kActual
    ) internal view returns (IOrionTransparentVault.Position[] memory intent) {
        uint256 totalTVL = 0;
        for (uint8 i = 0; i < kActual; ++i) {
            totalTVL += topTvls[i];
        }

        uint32 intentScale = uint32(10 ** config.curatorIntentDecimals());
        intent = new IOrionTransparentVault.Position[](kActual);

        uint32 sumWeights = 0;
        for (uint8 i = 0; i < kActual; ++i) {
            uint32 weight = uint32((topTvls[i] * intentScale) / totalTVL);
            intent[i] = IOrionTransparentVault.Position({ token: tokens[i], value: weight });
            sumWeights += weight;
        }

        if (sumWeights != intentScale) {
            uint32 diff = intentScale - sumWeights;
            intent[kActual - 1].value -= diff;
        }
    }

    /// @notice Owner can update k
    /// @param kNew The new number of assets to pick
    function updateParameters(uint8 kNew) external onlyOwner {
        k = kNew;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165) returns (bool) {
        return interfaceId == type(IOrionStrategy).interfaceId || super.supportsInterface(interfaceId);
    }
}
