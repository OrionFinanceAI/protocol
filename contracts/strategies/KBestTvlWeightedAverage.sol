// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategy } from "../interfaces/IOrionStrategy.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title KBestTvlWeightedAverage
 * @notice This strategy selects the top K assets based on their TVL and allocates them proportionally.
 * @author Orion Finance
 */
contract KBestTvlWeightedAverage is IOrionStrategy, Ownable2Step, ERC165 {
    /// @notice The Orion configuration contract
    IOrionConfig public config;

    /// @notice The number of assets to pick
    uint16 public k;
    /// @notice The maximum number of assets to pick
    uint16 public kMax;

    /// @notice Stored intent from last validateStrategy call (for fallback)
    IOrionTransparentVault.IntentPosition[] private _statefulIntent;

    /// @notice Constructor for KBestTvlWeightedAverage strategy
    /// @param owner The owner of the contract
    /// @param _config The Orion configuration contract address
    /// @param _k The number of assets to pick
    constructor(address owner, address _config, uint16 _k) Ownable(owner) {
        if (_config == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(_config);
        k = _k;
        kMax = 50;
    }

    /// @inheritdoc IOrionStrategy
    function computeIntent(
        address[] calldata vaultWhitelistedAssets
    ) external view returns (IOrionTransparentVault.IntentPosition[] memory intent) {
        uint16 n = uint16(vaultWhitelistedAssets.length);
        uint256[] memory tvls = _getAssetTVLs(vaultWhitelistedAssets, n);

        uint16 kActual = uint16(Math.min(Math.min(k, n), kMax));
        (address[] memory tokens, uint256[] memory topTvls) = _selectTopKAssets(
            vaultWhitelistedAssets,
            tvls,
            n,
            kActual
        );

        intent = _calculatePositions(tokens, topTvls, kActual);
    }

    /// @inheritdoc IOrionStrategy
    function validateStrategy(address[] calldata vaultWhitelistedAssets) external {
        uint16 n = uint16(vaultWhitelistedAssets.length);
        address referenceUnderlyingAsset = address(0);

        for (uint16 i = 0; i < n; ++i) {
            address asset = vaultWhitelistedAssets[i];

            // slither-disable-next-line unused-return
            try IERC4626(asset).totalAssets() returns (uint256) {
                // Asset is ERC4626 compliant, good.
            } catch {
                revert ErrorsLib.InvalidStrategy();
            }

            // Check that the underlying asset is the same across all assets in vaultWhitelistedAssets
            try IERC4626(asset).asset() returns (address vaultUnderlyingAsset) {
                if (referenceUnderlyingAsset == address(0)) {
                    referenceUnderlyingAsset = vaultUnderlyingAsset;
                } else if (vaultUnderlyingAsset != referenceUnderlyingAsset) {
                    revert ErrorsLib.InvalidStrategy();
                }
            } catch {
                revert ErrorsLib.InvalidStrategy();
            }
        }

        IOrionTransparentVault.IntentPosition[] memory computedIntent = this.computeIntent(vaultWhitelistedAssets);

        delete _statefulIntent;
        for (uint256 i = 0; i < computedIntent.length; ++i) {
            _statefulIntent.push(
                IOrionTransparentVault.IntentPosition({
                    token: computedIntent[i].token,
                    weight: computedIntent[i].weight
                })
            );
        }
    }

    /// @inheritdoc IOrionStrategy
    function getStatefulIntent() external view returns (IOrionTransparentVault.IntentPosition[] memory intent) {
        if (_statefulIntent.length == 0) revert ErrorsLib.InvalidStrategy();
        return _statefulIntent;
    }

    /// @notice Gets TVL for all whitelisted assets
    /// @param vaultWhitelistedAssets Array of whitelisted asset addresses
    /// @param n Number of assets
    /// @return tvls Array of TVL values
    function _getAssetTVLs(
        address[] calldata vaultWhitelistedAssets,
        uint16 n
    ) internal view returns (uint256[] memory tvls) {
        tvls = new uint256[](n);

        for (uint16 i = 0; i < n; ++i) {
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

        uint32 sumWeights = 0;
        for (uint16 i = 0; i < kActual; ++i) {
            uint32 weight = uint32((topTvls[i] * intentScale) / totalTVL);
            intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: weight });
            sumWeights += weight;
        }

        if (sumWeights < intentScale) {
            intent[kActual - 1].weight += intentScale - sumWeights;
        }
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
