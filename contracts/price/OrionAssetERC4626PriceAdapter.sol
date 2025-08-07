// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";

/**
 * @title OrionAssetERC4626PriceAdapter
 * @notice Price adapter for ERC-4626 vaults sharing the same underlying asset as the Orion protocol.
 * @dev This adapter assumes that the target vault and the Orion protocol use the same underlying asset.
 *      It is not safe to use this adapter with vaults that are based on a different asset.
 */
contract OrionAssetERC4626PriceAdapter is IPriceAdapter {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice Decimals of the underlying asset
    uint8 public underlyingAssetDecimals;

    /// @notice Price Adapter Precision
    uint8 public priceAdapterDecimals;

    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        underlyingAsset = address(config.underlyingAsset());
        underlyingAssetDecimals = IERC20Metadata(underlyingAsset).decimals();
        priceAdapterDecimals = config.priceAdapterDecimals();
    }

    /// @notice Returns the normalized price of one share of the given ERC4626 vault.
    /// @param vaultAsset The address of the ERC4626-compliant vault.
    /// @return The price of one share, normalized to priceAdapterDecimals decimals.
    /// @dev The price is always scaled to priceAdapterDecimals decimals, regardless of the vault decimals.
    function price(address vaultAsset) external view returns (uint256) {
        try IERC4626(vaultAsset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();
        } catch {
            revert ErrorsLib.InvalidAsset(); // Not a valid ERC4626 vault
        }

        uint8 vaultAssetDecimals = IERC20Metadata(vaultAsset).decimals();

        uint256 oneShare = 10 ** vaultAssetDecimals;
        uint256 underlyingAssetAmount = IERC4626(vaultAsset).convertToAssets(oneShare);
        // Normalize the price to priceAdapterDecimals decimals regardless of vault decimals
        if (underlyingAssetDecimals == priceAdapterDecimals) {
            return underlyingAssetAmount;
        } else if (underlyingAssetDecimals < priceAdapterDecimals) {
            return underlyingAssetAmount * (10 ** (priceAdapterDecimals - underlyingAssetDecimals));
        } else {
            return underlyingAssetAmount / (10 ** (underlyingAssetDecimals - priceAdapterDecimals));
        }
        // TODO: same logic as _convertDecimals from InternalStatesOrchestrator.sol, avoid code duplication
        // for security and readability.
    }
}
