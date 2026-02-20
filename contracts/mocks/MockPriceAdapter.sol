// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Price Adapter mock
/// @notice One instance per asset. For ERC4626 vaults, returns actual exchange rate. For other assets, returns configurable or default prices.
contract MockPriceAdapter is IPriceAdapter {
    /// @notice Configurable mock prices for non-ERC4626 assets
    mapping(address => uint256) public mockPrices;

    /// @notice Default price for non-ERC4626 assets when not explicitly configured (14-decimal scaled)
    uint256 public constant DEFAULT_MOCK_PRICE = 1e14; // 1.0 in 14 decimals

    /// @notice Maximum supported token decimals to prevent overflow in exponentiation
    uint8 public constant MAX_DECIMALS = 36;

    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    /// @notice Set a deterministic mock price for a non-ERC4626 asset
    /// @param asset The asset address
    /// @param price The price in 14-decimal format
    function setMockPrice(address asset, uint256 price) external {
        mockPrices[asset] = price;
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address asset) external view returns (uint256 price, uint8 decimals) {
        // Check if asset is an ERC4626 vault
        try IERC4626(asset).asset() returns (address) {
            // It's an ERC4626 vault - return actual exchange rate
            uint8 vaultDecimals = IERC20Metadata(asset).decimals();
            uint256 oneShare = 10 ** vaultDecimals;
            uint256 underlyingPerShare = IERC4626(asset).convertToAssets(oneShare);

            // Convert to 14 decimals (priceAdapterDecimals)
            uint8 underlyingDecimals = IERC20Metadata(IERC4626(asset).asset()).decimals();
            require(underlyingDecimals <= MAX_DECIMALS, "MockPriceAdapter: decimals too large");

            if (underlyingDecimals < 14) {
                price = underlyingPerShare * (10 ** (14 - underlyingDecimals));
            } else if (underlyingDecimals > 14) {
                price = underlyingPerShare / (10 ** (underlyingDecimals - 14));
            } else {
                price = underlyingPerShare;
            }

            return (price, 14);
        } catch {
            // Not an ERC4626 vault - return configured or default price
            uint256 configuredPrice = mockPrices[asset];
            price = configuredPrice > 0 ? configuredPrice : DEFAULT_MOCK_PRICE;
            return (price, 14);
        }
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address) external pure {
        // Mock adapter always validates successfully
    }
}
