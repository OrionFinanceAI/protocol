// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ERC4626PriceAdapter
 * @notice Price adapter for ERC-4626 vaults.
 * @author Orion Finance
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626PriceAdapter is IPriceAdapter {
    using Math for uint256;

    /// @notice Orion Config contract address
    IOrionConfig public immutable CONFIG;

    /// @notice Price adapter registry for vault underlying asset prices
    IPriceAdapterRegistry public immutable PRICE_REGISTRY;

    /// @notice Protocol underlying asset
    IERC20Metadata public immutable UNDERLYING_ASSET;

    /// @notice Decimals of the protocol underlying
    uint8 public immutable UNDERLYING_ASSET_DECIMALS;

    /// @notice Decimals of the price
    uint8 public constant PRICE_DECIMALS = 10;

    /// @notice Constructor
    /// @param configAddress The address of the OrionConfig contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        CONFIG = IOrionConfig(configAddress);
        PRICE_REGISTRY = IPriceAdapterRegistry(CONFIG.priceAdapterRegistry());
        UNDERLYING_ASSET = IERC20Metadata(address(CONFIG.underlyingAsset()));
        UNDERLYING_ASSET_DECIMALS = IERC20Metadata(UNDERLYING_ASSET).decimals();
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view {
        try IERC4626(asset).asset() returns (address vaultUnderlying) {
            if (!CONFIG.isWhitelisted(vaultUnderlying)) revert ErrorsLib.InvalidAdapter(asset);
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address vaultAsset) external view returns (uint256 price, uint8 decimals) {
        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        uint8 vaultAssetDecimals = IERC20Metadata(vaultAsset).decimals();
        uint256 precisionAmount = 10 ** (PRICE_DECIMALS + vaultAssetDecimals);

        // Floor rounding here, previewMint uses ceil in execution,
        // buffer to deal with negligible truncation and rounding errors.
        uint256 vaultUnderlyingAssetAmount = vault.convertToAssets(precisionAmount);

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            return (vaultUnderlyingAssetAmount, PRICE_DECIMALS + UNDERLYING_ASSET_DECIMALS);
        }

        uint256 vaultUnderlyingPrice = PRICE_REGISTRY.getPrice(vaultUnderlying);
        uint256 vaultPrice = vaultUnderlyingAssetAmount.mulDiv(
            vaultUnderlyingPrice,
            10 ** CONFIG.priceAdapterDecimals()
        );

        return (vaultPrice, PRICE_DECIMALS + CONFIG.getTokenDecimals(vaultUnderlying));
    }
}
