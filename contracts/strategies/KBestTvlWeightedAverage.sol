// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title KBestTvlWeightedAverage
 * @notice Selects the top-K assets by TVL from the protocol whitelist and allocates proportionally.
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract KBestTvlWeightedAverage is IOrionStrategist, ERC165, Ownable2Step, ReentrancyGuard {
    /// @notice The Orion configuration contract.
    IOrionConfig public immutable CONFIG;

    /// @notice The number of top assets to select.
    uint16 public k;

    /// @notice The vault this strategist is linked to. Set once via setVault; never changes.
    address private _vault;

    /// @notice Constructor to initialize the strategist with owner, config address, and number of top assets.
    /// @param owner_ Owner of this contract (can update k).
    /// @param config_ The Orion configuration contract address.
    /// @param k_ Number of top assets to select.
    constructor(address owner_, address config_, uint16 k_) Ownable(owner_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        CONFIG = IOrionConfig(config_);
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
    function submitIntent() external override onlyOwner nonReentrant {
        if (k == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        address vault_ = _vault;
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();

        address[] memory assets = CONFIG.getAllWhitelistedAssets();
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

    /// @dev Fetches TVL for each asset and normalizes it to a common price unit so that
    ///      ERC4626 vaults backed by different underlying tokens (and different decimals) are
    ///      directly comparable. Falls back to 1 whenever any external call fails so that
    ///      unresolvable assets are ranked last rather than causing a revert.
    function _getAssetTVLs(address[] memory assets, uint16 n) internal view returns (uint256[] memory tvls) {
        tvls = new uint256[](n);
        address protocolUnderlying = address(CONFIG.underlyingAsset());
        uint8 priceDecimals = CONFIG.priceAdapterDecimals();
        IPriceAdapterRegistry priceRegistry = IPriceAdapterRegistry(CONFIG.priceAdapterRegistry());
        for (uint16 i = 0; i < n; ++i) {
            tvls[i] = _normalizedTvl(assets[i], protocolUnderlying, priceDecimals, priceRegistry);
        }
    }

    /// @dev Returns the TVL of a single ERC4626 asset expressed in a common price unit.
    ///      normalizedTvl = rawTvl * underlyingPrice / 10^underlyingDecimals
    ///      where underlyingPrice is sourced from the protocol price registry and is already
    ///      in priceAdapterDecimals precision, making all results directly comparable.
    function _normalizedTvl(
        address asset,
        address protocolUnderlying,
        uint8 priceDecimals,
        IPriceAdapterRegistry priceRegistry
    ) private view returns (uint256) {
        uint256 rawTvl = 0;
        try IERC4626(asset).totalAssets() returns (uint256 tvl) {
            rawTvl = tvl;
        } catch {
            return 1;
        }

        address vaultUnderlying = address(0);
        try IERC4626(asset).asset() returns (address u) {
            vaultUnderlying = u;
        } catch {
            return 1;
        }

        uint8 underlyingDecimals = IERC20Metadata(vaultUnderlying).decimals();
        uint256 underlyingPrice = 0;

        if (vaultUnderlying == protocolUnderlying) {
            // TVL is already in protocol underlying units; use unit price in priceDecimals precision.
            underlyingPrice = 10 ** priceDecimals;
        } else {
            try priceRegistry.getPrice(vaultUnderlying) returns (uint256 p) {
                underlyingPrice = p;
            } catch {
                return 1;
            }
        }

        uint256 normalized = Math.mulDiv(rawTvl, underlyingPrice, 10 ** underlyingDecimals);
        return normalized == 0 ? 1 : normalized;
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

        uint32 intentScale = uint32(10 ** CONFIG.strategistIntentDecimals());
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
