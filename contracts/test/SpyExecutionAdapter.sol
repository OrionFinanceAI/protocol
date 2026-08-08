// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

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

    /// @notice USDC (or protocol underlying) returned per unit of vault-underlying sold (1e18 = 1:1)
    uint256 public sellRate = 1e18;

    /// @notice Recorded values from the last buy() call
    uint256 public lastBuyAllowanceReceived;
    uint256 public lastPreviewBuyResult;
    uint256 public lastSellAmount;

    event PreviewBuyCalled(uint256 result);
    event BuyCalled(uint256 underlyingReceived, uint256 underlyingSpent);
    event SellCalled(uint256 vaultUnderlyingIn, uint256 protocolUnderlyingOut);

    constructor(address underlying_) {
        UNDERLYING = IERC20(underlying_);
    }

    /// @notice Set the value previewBuy should return
    function setPreviewBuyReturn(uint256 amount) external {
        previewBuyReturn = amount;
    }

    /// @notice Set sell conversion rate: protocolUnderlyingOut = amount * sellRate / 1e18
    function setSellRate(uint256 rate) external {
        sellRate = rate;
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

        // Transfer requested output token to the caller (simulate swap)
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        if (assetBalance >= amount) {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }

        emit BuyCalled(lastBuyAllowanceReceived, executionUnderlyingAmount);
    }

    /// @inheritdoc IExecutionAdapter
    function sell(address asset, uint256 amount) external returns (uint256 executionUnderlyingAmount) {
        lastSellAmount = amount;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        executionUnderlyingAmount = (amount * sellRate) / 1e18;
        UNDERLYING.safeTransfer(msg.sender, executionUnderlyingAmount);
        emit SellCalled(amount, executionUnderlyingAmount);
    }

    /// @inheritdoc IExecutionAdapter
    // solhint-disable-next-line no-empty-blocks
    function validateExecutionAdapter(address) external pure {}
}
