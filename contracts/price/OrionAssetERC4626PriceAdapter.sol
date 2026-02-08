// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title OrionAssetERC4626PriceAdapter
 * @notice Price adapter for ERC-4626 vaults sharing the same underlying asset as the Orion protocol.
 * @author Orion Finance
 * @dev This adapter assumes that the target vault and the Orion protocol use the same underlying asset.
 *      It is not safe to use this adapter with vaults that are based on a different asset.
 * @custom:security-contact security@orionfinance.ai
 */
contract OrionAssetERC4626PriceAdapter is IPriceAdapter {
    using Math for uint256;

    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice Decimals of the underlying asset
    uint8 public underlyingAssetDecimals;

    /// @notice Decimals of the price
    uint8 public constant PRICE_DECIMALS = 10;

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
        uint256 precisionAmount = 10 ** (PRICE_DECIMALS + vaultAssetDecimals);

        // Floor rounding here, previewMint uses ceil in execution,
        // buffer to deal with negligible truncation and rounding errors.
        uint256 underlyingAssetAmount = IERC4626(vaultAsset).convertToAssets(precisionAmount);

        return (underlyingAssetAmount, PRICE_DECIMALS + underlyingAssetDecimals);
    }
}
