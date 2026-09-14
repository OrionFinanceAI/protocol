// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";
import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";

/**
 * @title LiquidityOrchestratorPriceHarness
 * @notice Minimal harness for Config live-read price snapshot tests (EIP-170 sized).
 */
contract LiquidityOrchestratorPriceHarness is LiquidityOrchestrator {
    /// @notice Test-only: run the same Config live-read price snapshot used at epoch start
    function h_snapshotEpochPricesFromConfig() external {
        address[] memory assets = config.getAllWhitelistedAssets();
        IPriceAdapterRegistry registry = IPriceAdapterRegistry(config.priceAdapterRegistry());
        for (uint16 i = 0; i < assets.length; ++i) {
            _currentEpoch.pricesEpoch[assets[i]] = registry.getPrice(assets[i]);
        }
    }
}
