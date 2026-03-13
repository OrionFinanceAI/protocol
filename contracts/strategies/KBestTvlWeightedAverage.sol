// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title KBestTvlWeightedAverage
 * @notice Selects the top-K assets by TVL from the protocol whitelist and allocates proportionally.
 * @author Orion Finance
 * @dev The investment universe is read from config at runtime via getAllWhitelistedAssets().
 *      Non-ERC4626 assets (e.g. the underlying stablecoin) receive a dust TVL of 1 via the
 *      try/catch and are effectively ranked last unless fewer than k real vaults exist.
 *      submitIntent is permissionless — the output is fully determined by on-chain state.
 * @custom:security-contact security@orionfinance.ai
 */
contract KBestTvlWeightedAverage is IOrionStrategist, ERC165, Ownable2Step {
    /// @notice The Orion configuration contract.
    IOrionConfig public immutable config;

    /// @notice The number of top assets to select.
    uint16 public k;

    /// @notice The vault this strategist is linked to. Set once via setVault; never changes.
    address private _vault;

    /// @param owner_ Owner of this contract (can update k).
    /// @param config_ The Orion configuration contract address.
    /// @param k_ Number of top assets to select.
    constructor(address owner_, address config_, uint16 k_) Ownable(owner_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(config_);
        k = k_;
    }

    /// @inheritdoc IOrionStrategist
    function setVault(address vault_) external {
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (_vault == vault_) return; // idempotent for same address
        if (_vault != address(0)) revert ErrorsLib.StrategistVaultAlreadyLinked();
        _vault = vault_;
    }

    /// @inheritdoc IOrionStrategist
    function submitIntent() external {
        if (k == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        address vault_ = _vault;
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();

        address[] memory assets = config.getAllWhitelistedAssets();
        uint16 n = uint16(assets.length);
        uint256[] memory tvls = _getAssetTVLs(assets, n);

        uint16 kActual = uint16(Math.min(k, n));
        (address[] memory tokens, uint256[] memory topTvls) = _selectTopKAssets(assets, tvls, n, kActual);

        IOrionTransparentVault.IntentPosition[] memory intent = _calculatePositions(tokens, topTvls, kActual);
        IOrionTransparentVault(vault_).submitIntent(intent);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IOrionStrategist).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @notice Update the number of top assets to select.
    /// @param kNew The new k value.
    function updateParameters(uint16 kNew) external onlyOwner {
        k = kNew;
    }

    /// @dev Fetches TVL for each asset via ERC4626.totalAssets(). Falls back to 1 on revert
    ///      so that non-ERC4626 tokens are ranked last rather than causing a revert.
    function _getAssetTVLs(address[] memory assets, uint16 n) internal view returns (uint256[] memory tvls) {
        tvls = new uint256[](n);
        for (uint16 i = 0; i < n; ++i) {
            try IERC4626(assets[i]).totalAssets() returns (uint256 tvl) {
                tvls[i] = tvl;
            } catch {
                tvls[i] = 1;
            }
        }
    }

    /// @dev O(n*k) selection to find the kActual highest-TVL assets without sorting the full array.
    function _selectTopKAssets(
        address[] memory assets,
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
            tokens[idx] = assets[maxIndex];
            topTvls[idx] = tvls[maxIndex];
        }
    }

    /// @dev Converts TVL values to proportional weights summing exactly to 10^intentDecimals.
    ///      Any rounding residual is added to the first position.
    function _calculatePositions(
        address[] memory tokens,
        uint256[] memory topTvls,
        uint16 kActual
    ) internal view returns (IOrionTransparentVault.IntentPosition[] memory intent) {
        uint256 totalTVL = 0;
        for (uint16 i = 0; i < kActual; ++i) {
            totalTVL += topTvls[i];
        }

        uint32 intentScale = uint32(10 ** config.strategistIntentDecimals());
        intent = new IOrionTransparentVault.IntentPosition[](kActual);

        uint32 sumWeights = 0;
        for (uint16 i = 0; i < kActual; ++i) {
            uint32 weight = uint32((topTvls[i] * intentScale) / totalTVL);
            intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: weight });
            sumWeights += weight;
        }

        // Assign rounding residual to first position to guarantee exact sum.
        if (sumWeights < intentScale) {
            intent[0].weight += intentScale - sumWeights;
        }
    }
}
