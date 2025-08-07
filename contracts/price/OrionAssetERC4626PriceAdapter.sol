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

    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        underlyingAsset = address(config.underlyingAsset());
        underlyingAssetDecimals = IERC20Metadata(underlyingAsset).decimals();
    }

    /// @inheritdoc IPriceAdapter
    /// @notice Returns the raw price of one share of the given ERC4626 vault in underlying asset decimals.
    /// @param vaultAsset The address of the ERC4626-compliant vault.
    /// @return price The raw price of one share in underlying asset decimals
    /// @return decimals The number of decimals for the returned price (underlying asset decimals)
    function getPriceData(address vaultAsset) external view returns (uint256 price, uint8 decimals) {
        try IERC4626(vaultAsset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();
        } catch {
            revert ErrorsLib.InvalidAsset(); // Not a valid ERC4626 vault
        }

        uint8 vaultAssetDecimals = IERC20Metadata(vaultAsset).decimals();
        uint256 oneShare = 10 ** vaultAssetDecimals;
        uint256 underlyingAssetAmount = IERC4626(vaultAsset).convertToAssets(oneShare);

        return (underlyingAssetAmount, underlyingAssetDecimals);
    }
}
