// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title KBestTvlWeightedAverageInvalid
 * @notice Test contract — identical to KBestTvlWeightedAverage but intentionally omits the
 *         rounding-residual adjustment, causing weights to not sum to intentScale.
 *         Used to verify that OrionTransparentVault.submitIntent rejects invalid weights.
 * @author Orion Finance
 */
contract KBestTvlWeightedAverageInvalid is IOrionStrategist, ERC165, Ownable {
    IOrionConfig public immutable config;
    uint16 public k;
    address private _vault;

    constructor(address owner_, address config_, uint16 k_) Ownable(owner_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(config_);
        k = k_;
    }

    /// @inheritdoc IOrionStrategist
    function setVault(address vault_) external {
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (_vault == vault_) return;
        if (_vault != address(0)) revert ErrorsLib.StrategistVaultAlreadyLinked();
        _vault = vault_;
    }

    /// @inheritdoc IOrionStrategist
    function submitIntent() external {
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

    function updateParameters(uint16 kNew) external onlyOwner {
        k = kNew;
    }

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

    /// @notice Intentionally omits the rounding-residual adjustment so weights may not sum
    ///         to intentScale, causing OrionTransparentVault.submitIntent to revert.
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

        for (uint16 i = 0; i < kActual; ++i) {
            uint32 weight = uint32((topTvls[i] * intentScale) / totalTVL);
            intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: weight });
        }
        // Rounding residual intentionally NOT added — weights will not sum to intentScale.
    }
}
