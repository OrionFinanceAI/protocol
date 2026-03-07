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
 * @title ApyStrategistBase
 * @notice Abstract base for APY-ranked strategists. Maintains per-asset share-price checkpoints
 *         and derives annualised returns via: APY = (P₁ − P₀) / P₀ × SECONDS_PER_YEAR / elapsed.
 * @author Orion Finance
 * @dev Non-ERC4626 assets return APY = 0. Negative or flat returns return APY = 0.
 *      Checkpoints are rate-gated to MIN_WINDOW per asset to prevent griefing.
 * @custom:security-contact security@orionfinance.ai
 */
abstract contract ApyStrategistBase is IOrionStrategist, ERC165, Ownable2Step {
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MIN_WINDOW = 1 hours;

    /// @dev Packed into one storage slot (128 + 48 = 176 bits).
    struct Checkpoint {
        uint128 sharePrice;
        uint48 timestamp;
    }

    /// @notice The Orion configuration contract.
    IOrionConfig public immutable config;

    address private _vault;

    mapping(address => Checkpoint) private _checkpoints;

    /// @notice Emitted when a share-price checkpoint is recorded for an asset.
    /// @param asset     The asset address.
    /// @param sharePrice The recorded share price (convertToAssets(1 share)).
    /// @param timestamp  Block timestamp of the checkpoint.
    event CheckpointRecorded(address indexed asset, uint128 indexed sharePrice, uint48 indexed timestamp);

    constructor(address owner_, address config_) Ownable(owner_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(config_);
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

    /// @notice Snapshot the current share price for a batch of assets. Permissionless.
    /// @dev Skips assets whose checkpoint is younger than MIN_WINDOW, non-ERC4626 assets,
    ///      and prices that overflow uint128.
    /// @param assets Asset addresses to snapshot.
    function updateCheckpoints(address[] calldata assets) external {
        uint16 n = uint16(assets.length);
        for (uint16 i = 0; i < n; ++i) {
            _recordCheckpoint(assets[i]);
        }
    }

    /// @notice Returns the stored checkpoint for an asset.
    /// @param asset The asset address to query.
    /// @return sharePrice The last recorded share price.
    /// @return timestamp  The block timestamp when the checkpoint was recorded.
    function getCheckpoint(address asset) external view returns (uint128 sharePrice, uint48 timestamp) {
        Checkpoint memory cp = _checkpoints[asset];
        return (cp.sharePrice, cp.timestamp);
    }

    /// @dev Skips if the existing checkpoint is less than MIN_WINDOW old. This rate-gate
    ///      prevents a griefer from front-running submitIntent with a checkpoint reset that
    ///      collapses elapsed time to zero and forces the equal-weight fallback.
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
    ///      dec > 76 guard prevents 10**dec from overflowing uint256.
    function _getSharePrice(address asset) private view returns (uint256) {
        uint8 dec;
        try IERC4626(asset).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return 0;
        }
        if (dec > 76) return 0;
        try IERC4626(asset).convertToAssets(10 ** dec) returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }

    /// @dev Returns APY in WAD (1e18 = 100%). Returns 0 if no checkpoint, window too short,
    ///      or return is non-positive.
    function _getAssetApy(address asset) internal view returns (uint256) {
        Checkpoint memory cp = _checkpoints[asset];
        if (cp.sharePrice == 0 || cp.timestamp == 0) return 0;

        uint256 elapsed = block.timestamp - cp.timestamp;
        if (elapsed < MIN_WINDOW) return 0;

        uint256 currentPrice = _getSharePrice(asset);
        if (currentPrice == 0 || currentPrice > type(uint128).max) return 0;
        if (currentPrice < cp.sharePrice) return 0;

        // APY = (currentPrice − storedPrice) × WAD × SECONDS_PER_YEAR / (storedPrice × elapsed)
        return Math.mulDiv((currentPrice - cp.sharePrice) * WAD, SECONDS_PER_YEAR, uint256(cp.sharePrice) * elapsed);
    }

    function _getAssetApys(address[] memory assets, uint16 n) internal view returns (uint256[] memory apys) {
        apys = new uint256[](n);
        for (uint16 i = 0; i < n; ++i) {
            apys[i] = _getAssetApy(assets[i]);
        }
    }

    /// @dev O(n × kActual) top-K selection. Uses type(uint16).max as a sentinel so ties and
    ///      all-zero APYs advance through the array without producing duplicate tokens.
    ///      Safe: kActual ≤ n guarantees the sentinel is always replaced in the inner loop.
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

    function _submitIntentInternal(uint16 k_) internal {
        if (k_ == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        address vault_ = _vault;
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();

        address[] memory assets = config.getAllWhitelistedAssets();
        uint16 n = uint16(assets.length);
        if (n == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        uint256[] memory apys = _getAssetApys(assets, n);
        uint16 kActual = uint16(Math.min(k_, n));

        (address[] memory tokens, uint256[] memory topApys) = _selectTopKByApy(assets, apys, n, kActual);
        IOrionTransparentVault.IntentPosition[] memory intent = _buildIntent(tokens, topApys, kActual);
        IOrionTransparentVault(vault_).submitIntent(intent);
    }

    /// @dev Subclasses implement this to apply a weighting scheme to the selected tokens.
    ///      Must return exactly kActual positions with weights summing to intentScale.
    function _buildIntent(
        address[] memory tokens,
        uint256[] memory topApys,
        uint16 kActual
    ) internal view virtual returns (IOrionTransparentVault.IntentPosition[] memory);
}
