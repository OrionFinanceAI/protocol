// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";

/// @title Execution Adapter mock
/// @notice Mock implementation of IExecutionAdapter for testing
contract MockExecutionAdapter is IExecutionAdapter {
    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    /// @inheritdoc IExecutionAdapter
    // solhint-disable-next-line no-empty-blocks
    function buy(address asset, uint256 amount) external {}

    /// @inheritdoc IExecutionAdapter
    // solhint-disable-next-line no-empty-blocks
    function sell(address asset, uint256 amount) external {}
}
