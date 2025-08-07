// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";

/**
 * @title UnderlyingPriceAdapter
 * @notice Price adapter for the underlying asset of the Orion protocol.
 * @dev Returns the price of the underlying asset in its native decimals.
 */
contract UnderlyingPriceAdapter is IPriceAdapter {
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
    function getPriceData(address) external view returns (uint256 price, uint8 decimals) {
        // For underlying asset, price is always 1 in its native decimals
        return (10 ** underlyingAssetDecimals, underlyingAssetDecimals);
    }
}
