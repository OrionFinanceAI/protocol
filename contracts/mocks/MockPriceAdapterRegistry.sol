// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";
import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";

/**
 * @title MockPriceAdapterRegistry
 * @notice Minimal mock registry for E2E testing
 * @dev Maps assets to price adapters and returns normalized prices
 */
contract MockPriceAdapterRegistry is IPriceAdapterRegistry {
    mapping(address => IPriceAdapter) public adapterOf;

    /// @inheritdoc IPriceAdapterRegistry
    function setPriceAdapter(address asset, IPriceAdapter adapter) external override {
        adapterOf[asset] = adapter;
    }

    /// @inheritdoc IPriceAdapterRegistry
    function getPrice(address asset) external view override returns (uint256) {
        IPriceAdapter adapter = adapterOf[asset];
        require(address(adapter) != address(0), "No adapter set");

        (uint256 price, ) = adapter.getPriceData(asset);
        return price;
    }
}
