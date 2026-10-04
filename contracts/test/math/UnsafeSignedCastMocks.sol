// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../../libraries/ErrorsLib.sol";

/**
 * @title UnsafeSignedCastOrchestrator
 * @notice Legacy twin: raw `uint256` → `int256` casts on buffer updates (pre-SafeCast).
 * @dev `depositLiquidity` of `amount > int256.max` wraps to a negative delta and shrinks the buffer.
 *      `withdrawLiquidity` of `amount > int256.max` flips to a positive delta; the checked add then
 *      overflows when `buffer >= amount`, so tokens are not sent.
 */
contract UnsafeSignedCastOrchestrator {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlyingAsset;
    uint256 public bufferAmount;

    constructor(IERC20 underlyingAsset_) {
        underlyingAsset = underlyingAsset_;
    }

    function setBufferAmount(uint256 amount) external {
        bufferAmount = amount;
    }

    function depositLiquidity(uint256 amount) external {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(underlyingAsset));

        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);
        _updateBufferAmount(int256(amount));
    }

    function withdrawLiquidity(uint256 amount) external {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(underlyingAsset));
        if (amount > bufferAmount) revert ErrorsLib.InsufficientAmount();

        _updateBufferAmount(-int256(amount));
        underlyingAsset.safeTransfer(msg.sender, amount);
    }

    /// @dev Pre-fix helper: `uint256(-delta)` panics when `delta == type(int256).min`.
    function _updateBufferAmount(int256 deltaAmount) internal {
        if (deltaAmount > 0) {
            bufferAmount += uint256(deltaAmount);
        } else if (deltaAmount < 0) {
            bufferAmount -= uint256(-deltaAmount);
        }
    }
}
