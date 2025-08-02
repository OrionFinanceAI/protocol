// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
contract OrionAssetERC4626PriceAdapter is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IPriceAdapter {
    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice Decimals of the underlying asset
    uint8 public underlyingAssetDecimals;

    function initialize(address initialOwner, address _configAddress) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        if (_configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        underlyingAsset = address(IOrionConfig(_configAddress).underlyingAsset());
        underlyingAssetDecimals = IERC20Metadata(underlyingAsset).decimals();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Returns the normalized price of one share of the given ERC4626 vault.
    /// @param vaultAsset The address of the ERC4626-compliant vault.
    /// @return The price of one share, normalized to 18 decimals.
    /// @dev The price is always scaled to 18 decimals, regardless of the vault decimals.
    function price(address vaultAsset) external view returns (uint256) {
        address vaultUnderlyingAsset = IERC4626(vaultAsset).asset();
        if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();

        uint8 vaultAssetDecimals = IERC20Metadata(vaultAsset).decimals();

        uint256 oneShare = 10 ** vaultAssetDecimals;
        uint256 underlyingAssetAmount = IERC4626(vaultAsset).convertToAssets(oneShare);
        // Normalize the price to 18 decimals regardless of vault decimals
        if (underlyingAssetDecimals == 18) {
            return underlyingAssetAmount;
        } else if (underlyingAssetDecimals < 18) {
            return underlyingAssetAmount * (10 ** (18 - underlyingAssetDecimals));
        } else {
            return underlyingAssetAmount / (10 ** (underlyingAssetDecimals - 18));
        }
    }
}
