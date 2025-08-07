// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";

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

    function getPriceData(address) external view returns (uint256 price, uint8 decimals) {
        price = 10 ** underlyingAssetDecimals;
        decimals = underlyingAssetDecimals;
        return (price, decimals);
    }
}
