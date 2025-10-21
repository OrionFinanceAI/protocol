// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";

/// @title Execution Adapter mock
/// @notice Mock implementation of IExecutionAdapter for testing
contract MockExecutionAdapter is IExecutionAdapter {
    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    /// @inheritdoc IExecutionAdapter
    function buy(address asset, uint256 sharesAmount) external returns (uint256 executionUnderlyingAmount) {
        executionUnderlyingAmount = 1e12;
    }

    /// @inheritdoc IExecutionAdapter
    function sell(address asset, uint256 sharesAmount) external returns (uint256 executionUnderlyingAmount) {
        executionUnderlyingAmount = 1e12;
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override returns (bool) {
        // Mock always returns true for validation
        return true;
    }
}
