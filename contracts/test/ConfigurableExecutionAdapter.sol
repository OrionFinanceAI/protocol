// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ConfigurableExecutionAdapter
/// @notice Test adapter with per-asset revert flags and call counters
contract ConfigurableExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable UNDERLYING;

    mapping(address => bool) public sellShouldRevert;
    mapping(address => bool) public buyShouldRevert;
    mapping(address => uint256) public sellCallCount;
    mapping(address => uint256) public buyCallCount;

    uint256 public sellReturnAmount = 1e18;
    uint256 public buyReturnAmount = 1e18;

    constructor(address underlying_) {
        UNDERLYING = IERC20(underlying_);
    }

    function setSellRevert(address asset, bool shouldRevert) external {
        sellShouldRevert[asset] = shouldRevert;
    }

    function setBuyRevert(address asset, bool shouldRevert) external {
        buyShouldRevert[asset] = shouldRevert;
    }

    function setSellReturnAmount(uint256 amount) external {
        sellReturnAmount = amount;
    }

    function setBuyReturnAmount(uint256 amount) external {
        buyReturnAmount = amount;
    }

    /// @inheritdoc IExecutionAdapter
    function previewBuy(address, uint256) external pure returns (uint256 underlyingAmount) {
        underlyingAmount = 1e18;
    }

    /// @inheritdoc IExecutionAdapter
    function buy(address asset, uint256) external returns (uint256 executionUnderlyingAmount) {
        unchecked {
            ++buyCallCount[asset];
        }
        if (buyShouldRevert[asset]) revert("BUY_REVERT");

        uint256 allowance = UNDERLYING.allowance(msg.sender, address(this));
        if (allowance > 0) {
            UNDERLYING.safeTransferFrom(msg.sender, address(this), allowance);
        }
        executionUnderlyingAmount = buyReturnAmount;
    }

    /// @inheritdoc IExecutionAdapter
    function sell(address asset, uint256 amount) external returns (uint256 executionUnderlyingAmount) {
        unchecked {
            ++sellCallCount[asset];
        }
        if (sellShouldRevert[asset]) revert("SELL_REVERT");

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        UNDERLYING.safeTransfer(msg.sender, sellReturnAmount);
        executionUnderlyingAmount = sellReturnAmount;
    }

    /// @inheritdoc IExecutionAdapter
    // solhint-disable-next-line no-empty-blocks
    function validateExecutionAdapter(address) external pure {}
}
