// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SpyExecutionAdapter
/// @notice Mock that records previewBuy/buy values to verify atomic consistency
contract SpyExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable UNDERLYING;

    /// @notice The value previewBuy will return (set by test)
    uint256 public previewBuyReturn;

    /// @notice Recorded values from the last buy() call
    uint256 public lastBuyAllowanceReceived;
    uint256 public lastPreviewBuyResult;

    event PreviewBuyCalled(uint256 result);
    event BuyCalled(uint256 underlyingReceived, uint256 underlyingSpent);

    constructor(address underlying_) {
        UNDERLYING = IERC20(underlying_);
    }

    /// @notice Set the value previewBuy should return
    function setPreviewBuyReturn(uint256 amount) external {
        previewBuyReturn = amount;
    }

    /// @inheritdoc IExecutionAdapter
    function previewBuy(address, uint256) external returns (uint256 underlyingAmount) {
        underlyingAmount = previewBuyReturn;
        lastPreviewBuyResult = underlyingAmount;
        emit PreviewBuyCalled(underlyingAmount);
    }

    /// @inheritdoc IExecutionAdapter
    function buy(address asset, uint256 amount) external returns (uint256 executionUnderlyingAmount) {
        // Record how much underlying was actually transferred to us
        lastBuyAllowanceReceived = UNDERLYING.allowance(msg.sender, address(this));

        // Pull the underlying from caller
        UNDERLYING.safeTransferFrom(msg.sender, address(this), lastBuyAllowanceReceived);
        executionUnderlyingAmount = lastBuyAllowanceReceived;

        // Mint the requested output token to the caller (simulate swap)
        // We need to transfer `amount` of the asset token to msg.sender
        // For testing, we just transfer whatever asset tokens we hold
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        if (assetBalance >= amount) {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }

        emit BuyCalled(lastBuyAllowanceReceived, executionUnderlyingAmount);
    }

    /// @inheritdoc IExecutionAdapter
    function sell(address, uint256) external pure returns (uint256 executionUnderlyingAmount) {
        executionUnderlyingAmount = 0;
    }

    /// @inheritdoc IExecutionAdapter
    // solhint-disable-next-line no-empty-blocks
    function validateExecutionAdapter(address) external pure {}
}
