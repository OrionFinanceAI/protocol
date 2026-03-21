// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title KBestApyStrategist
 * @notice Top-K asset selection by estimated APY with configurable weighting: equal weights or APY-proportional.
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract KBestApyStrategist is IOrionStrategist, ERC165, Ownable2Step, ReentrancyGuard {
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MIN_WINDOW = 1 hours;

    /// @notice How selected tokens are weighted in the intent.
    enum WeightingMode {
        EqualWeighted,
        ApyWeighted
    }

    /// @dev Packed into one storage slot (128 + 48 = 176 bits).
    struct Checkpoint {
        uint128 sharePrice;
        uint48 timestamp;
    }

    /// @notice Weighting strategy; fixed at deployment.
    WeightingMode public immutable WEIGHTING_MODE;

    /// @notice The Orion configuration contract.
    IOrionConfig public immutable CONFIG;

    /// @notice Number of top assets to select.
    uint16 public k;

    /// @notice Emitted when `updateParameters` changes the top-K count.
    /// @param oldK The previous value of top-K.
    /// @param newK The new value of top-K after the update.
    event KUpdated(uint16 indexed oldK, uint16 indexed newK);

    address private _vault;

    mapping(address => Checkpoint) private _checkpoints;

    /**
     * @notice Emitted when a share-price checkpoint is recorded for an asset (end of `submitIntent`).
     * @param asset The address of the asset for which the checkpoint is recorded.
     * @param sharePrice The share price value at the checkpoint.
     * @param timestamp The timestamp when the checkpoint was recorded.
     */
    event CheckpointRecorded(address indexed asset, uint128 indexed sharePrice, uint48 indexed timestamp);

    /// @notice Initializes the KBestApyStrategist contract with owner, config, k, and weighting mode.
    /// @param owner_   Owner of this contract (can update k).
    /// @param config_  OrionConfig address.
    /// @param k_       Initial number of top assets to select.
    /// @param mode_    EqualWeighted: equal split among top-K; ApyWeighted: weights ∝ APY (equal if all APY zero).
    constructor(address owner_, address config_, uint16 k_, WeightingMode mode_) Ownable(owner_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (k_ == 0) revert ErrorsLib.InvalidArguments();

        CONFIG = IOrionConfig(config_);
        k = k_;
        WEIGHTING_MODE = mode_;

        address[] memory assets = CONFIG.getAllWhitelistedAssets();
        uint16 n = uint16(assets.length);
        _recordCheckpointsForAssets(assets, n);
    }

    /// @inheritdoc IOrionStrategist
    function setVault(address vault_) external {
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (_vault == vault_) return;
        if (_vault != address(0)) revert ErrorsLib.StrategistVaultAlreadyLinked();
        _vault = vault_;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IOrionStrategist).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IOrionStrategist
    function submitIntent() external override nonReentrant {
        if (k == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        address vault_ = _vault;
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();

        address[] memory assets = CONFIG.getAllWhitelistedAssets();
        uint16 n = uint16(assets.length);

        uint256[] memory apys = _getAssetApys(assets, n);
        uint16 kActual = uint16(Math.min(k, n));

        (address[] memory tokens, uint256[] memory topApys) = _selectTopKByApy(assets, apys, n, kActual);
        IOrionTransparentVault.IntentPosition[] memory intent = _buildIntent(tokens, topApys, kActual);

        // slither-disable-start reentrancy-no-eth
        IOrionTransparentVault(vault_).submitIntent(intent);
        _recordCheckpointsForAssets(assets, n);
        // slither-disable-end reentrancy-no-eth
    }

    /// @notice Update the number of top assets to select.
    /// @param kNew The new value for k (number of top assets to select).
    function updateParameters(uint16 kNew) external onlyOwner {
        uint16 oldK = k;
        k = kNew;
        emit KUpdated(oldK, kNew);
    }

    /// @dev Records checkpoints for a fixed asset list.
    function _recordCheckpointsForAssets(address[] memory assets, uint16 n) internal {
        for (uint16 i = 0; i < n; ++i) {
            _recordCheckpoint(assets[i]);
        }
    }

    /// @dev Skips if the existing checkpoint is less than MIN_WINDOW old.
    function _recordCheckpoint(address asset) internal {
        Checkpoint memory existing = _checkpoints[asset];
        if (existing.timestamp != 0 && block.timestamp - uint256(existing.timestamp) < MIN_WINDOW) return;
        uint256 price = _getSharePrice(asset);
        if (price == 0 || price > type(uint128).max) return;
        uint48 now_ = uint48(block.timestamp);
        _checkpoints[asset] = Checkpoint({ sharePrice: uint128(price), timestamp: now_ });
        emit CheckpointRecorded(asset, uint128(price), now_);
    }

    /// @dev Returns convertToAssets(1 share) or 0 on any failure.
    function _getSharePrice(address asset) private view returns (uint256) {
        uint8 dec = 0;
        try IERC4626(asset).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return 0;
        }
        try IERC4626(asset).convertToAssets(10 ** dec) returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }

    function _getAssetApy(address asset) internal view returns (uint256) {
        Checkpoint memory cp = _checkpoints[asset];
        // slither-disable-next-line incorrect-equality
        if (cp.sharePrice == 0 || cp.timestamp == 0) return 0;

        uint256 elapsed = block.timestamp - cp.timestamp;
        if (elapsed < MIN_WINDOW) return 0;

        uint256 currentPrice = _getSharePrice(asset);
        if (currentPrice == 0 || currentPrice > type(uint128).max) return 0;
        if (currentPrice < cp.sharePrice) return 0;

        uint256 delta = currentPrice - uint256(cp.sharePrice);
        uint256 tmp = Math.mulDiv(delta, WAD, uint256(cp.sharePrice));
        return Math.mulDiv(tmp, SECONDS_PER_YEAR, elapsed);
    }

    function _getAssetApys(address[] memory assets, uint16 n) internal view returns (uint256[] memory apys) {
        apys = new uint256[](n);
        for (uint16 i = 0; i < n; ++i) {
            apys[i] = _getAssetApy(assets[i]);
        }
    }

    function _selectTopKByApy(
        address[] memory assets,
        uint256[] memory apys,
        uint16 n,
        uint16 kActual
    ) internal pure returns (address[] memory tokens, uint256[] memory topApys) {
        tokens = new address[](kActual);
        topApys = new uint256[](kActual);
        bool[] memory used = new bool[](n);

        for (uint16 idx = 0; idx < kActual; ++idx) {
            uint256 maxApy = 0;
            uint16 maxIndex = type(uint16).max;

            for (uint16 j = 0; j < n; ++j) {
                if (!used[j] && (maxIndex == type(uint16).max || apys[j] > maxApy)) {
                    maxApy = apys[j];
                    maxIndex = j;
                }
            }
            used[maxIndex] = true;
            tokens[idx] = assets[maxIndex];
            topApys[idx] = apys[maxIndex];
        }
    }

    function _buildIntent(
        address[] memory tokens,
        uint256[] memory topApys,
        uint16 kActual
    ) internal view returns (IOrionTransparentVault.IntentPosition[] memory intent) {
        uint32 intentScale = uint32(10 ** CONFIG.strategistIntentDecimals());
        intent = new IOrionTransparentVault.IntentPosition[](kActual);
        uint32 sumWeights = 0;

        if (WEIGHTING_MODE == WeightingMode.EqualWeighted) {
            uint32 equalWeight = uint32(intentScale / kActual);
            for (uint16 i = 0; i < kActual; ++i) {
                intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: equalWeight });
                sumWeights += equalWeight;
            }
        } else {
            uint256 totalApy = 0;
            for (uint16 i = 0; i < kActual; ++i) {
                totalApy += topApys[i];
            }

            // slither-disable-next-line incorrect-equality
            if (totalApy == 0) {
                uint32 equalWeight = uint32(intentScale / kActual);
                for (uint16 i = 0; i < kActual; ++i) {
                    intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: equalWeight });
                    sumWeights += equalWeight;
                }
            } else {
                for (uint16 i = 0; i < kActual; ++i) {
                    uint32 weight = uint32(Math.mulDiv(topApys[i], intentScale, totalApy));
                    intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: weight });
                    sumWeights += weight;
                }
            }
        }

        if (sumWeights < intentScale) {
            intent[0].weight += intentScale - sumWeights;
        }
    }
}
