// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Price Adapter mock
/// @notice One instance per asset. For ERC4626 vaults, returns actual exchange rate. For other assets, produces pseudo-random prices.
contract MockPriceAdapter is IPriceAdapter {
    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    /// @inheritdoc IPriceAdapter
    function getPriceData(address asset) external view returns (uint256 price, uint8 decimals) {
        // Check if asset is an ERC4626 vault
        try IERC4626(asset).asset() returns (address) {
            // It's an ERC4626 vault - return actual exchange rate
            uint8 vaultDecimals = IERC20Metadata(asset).decimals();
            uint256 oneShare = 10 ** vaultDecimals;
            uint256 underlyingPerShare = IERC4626(asset).convertToAssets(oneShare);

            // Convert to 14 decimals (priceAdapterDecimals)
            // underlyingPerShare is in underlying decimals, we need it in 14 decimals
            // For same-asset USDC vaults: underlying is 12 decimals
            // So we scale up by 2 decimals: underlyingPerShare * 10^2
            // But we need to generalize for any underlying decimals
            uint8 underlyingDecimals = IERC20Metadata(IERC4626(asset).asset()).decimals();

            if (underlyingDecimals < 14) {
                price = underlyingPerShare * (10 ** (14 - underlyingDecimals));
            } else if (underlyingDecimals > 14) {
                price = underlyingPerShare / (10 ** (underlyingDecimals - 14));
            } else {
                price = underlyingPerShare;
            }

            return (price, 14);
        } catch {
            // Not an ERC4626 vault - return mock random price
            uint256 mockPrice = (uint256(
                keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, asset))
            ) % 100) + 1;
            return (mockPrice, 14); // Mock price with 14 decimals (matching priceAdapterDecimals)
        }
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address) external pure {
        // Mock adapter always validates successfully
    }
}
