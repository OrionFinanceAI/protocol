// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
/**
 * @title ERC4626PriceAdapter
 * @notice Price adapter for ERC-4626 vaults.
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626PriceAdapter is IPriceAdapter {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice Decimals of the underlying asset
    uint8 public underlyingAssetDecimals;

    /// @notice Constructor
    /// @param configAddress The address of the OrionConfig contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        underlyingAsset = address(config.underlyingAsset());
        underlyingAssetDecimals = IERC20Metadata(underlyingAsset).decimals();
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view {
        try IERC4626(asset).asset() returns (address underlying) {
            if (underlying != underlyingAsset) revert ErrorsLib.InvalidAdapter(asset);
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address vaultAsset) external view returns (uint256 price, uint8 decimals) {
        uint8 vaultAssetDecimals = IERC20Metadata(vaultAsset).decimals();
        uint256 oneShare = 10 ** vaultAssetDecimals;

        // Floor rounding here, previewMint uses ceil in execution, buffer to deal with rounding errors.
        uint256 vaultUnderlyingAssetAmount = IERC4626(vaultAsset).convertToAssets(oneShare);

        // TODO
        // underlyingAssetDecimals = IERC4626(vault).asset().decimals()

        // [ERC4626/WBTC]
        // uint256 underlyingAssetPrice, uint8 underlyingAssetPriceDecimals = IPriceAdapter(address feedAdapterAddress).getPrice(vaultUnderlyingAsset)
        // WBTC/USDC
        // underlyingAssetAmount = vaultUnderlyingAssetAmount * underlyingAssetPrice) // ERC4626/USDC

        // 1 ERC4626/WBTC = 1*10000
        // 1 WBTC/USDC = 1000000

        // 1 ERC4626/USDC = 1*10000 * 1000000 = 10000000000

        // return (underlyingAssetAmount, underlyingAssetDecimals+underlyingAssetPriceDecimals);
    }
}