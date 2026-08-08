// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ControllableExecutionAdapter
 * @notice Test adapter with configurable buy/sell return values for buffer-delta unit tests
 */
contract ControllableExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable UNDERLYING;
    uint256 public sellReturn;
    uint256 public buyReturn;
    bool public sellReverts;
    bool public buyReverts;

    constructor(address underlying_) {
        UNDERLYING = IERC20(underlying_);
    }

    function setSellReturn(uint256 amount) external {
        sellReturn = amount;
    }

    function setBuyReturn(uint256 amount) external {
        buyReturn = amount;
    }

    function setSellReverts(bool reverts_) external {
        sellReverts = reverts_;
    }

    function setBuyReverts(bool reverts_) external {
        buyReverts = reverts_;
    }

    /// @inheritdoc IExecutionAdapter
    function previewBuy(address, uint256) external view returns (uint256 underlyingAmount) {
        underlyingAmount = buyReturn;
    }

    /// @inheritdoc IExecutionAdapter
    function buy(address, uint256) external returns (uint256 executionUnderlyingAmount) {
        if (buyReverts) revert("buy revert");
        executionUnderlyingAmount = buyReturn;
        if (executionUnderlyingAmount > 0) {
            UNDERLYING.safeTransferFrom(msg.sender, address(this), executionUnderlyingAmount);
        }
    }

    /// @inheritdoc IExecutionAdapter
    function sell(address, uint256) external returns (uint256 executionUnderlyingAmount) {
        if (sellReverts) revert("sell revert");
        executionUnderlyingAmount = sellReturn;
    }

    /// @inheritdoc IExecutionAdapter
    // solhint-disable-next-line no-empty-blocks
    function validateExecutionAdapter(address) external pure {}
}
