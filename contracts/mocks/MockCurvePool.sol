// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockCurvePool
 * @notice Mock Curve pool for testing swap executors
 * @dev Simulates both exchange and exchange_underlying functions
 */
contract MockCurvePool {
    using SafeERC20 for IERC20;

    // Test configuration
    uint256 public nextExchangeResult;
    bool public shouldRevert;
    bool public lastUsedUnderlying;

    // Track token addresses for transfers
    address public tokenOut;

    function setNextExchangeResult(uint256 _result) external {
        nextExchangeResult = _result;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function setTokenOut(address _tokenOut) external {
        tokenOut = _tokenOut;
    }

    function exchange(int128, int128, uint256, uint256 min_dy) external returns (uint256) {
        if (shouldRevert) revert("Mock revert");

        lastUsedUnderlying = false;

        uint256 dy = nextExchangeResult;
        require(dy >= min_dy, "Insufficient output");

        // Mock: mint output tokens to the caller (executor)
        if (tokenOut != address(0)) {
            _mintOrTransfer(tokenOut, msg.sender, dy);
        }

        return dy;
    }

    function exchange_underlying(int128, int128, uint256, uint256 min_dy) external returns (uint256) {
        if (shouldRevert) revert("Mock revert");

        lastUsedUnderlying = true;

        uint256 dy = nextExchangeResult;
        require(dy >= min_dy, "Insufficient output");

        // Mock: mint output tokens to the caller (executor)
        if (tokenOut != address(0)) {
            _mintOrTransfer(tokenOut, msg.sender, dy);
        }

        return dy;
    }

    function _mintOrTransfer(address token, address to, uint256 amount) internal {
        // Try to mint tokens (for testing with MockUnderlyingAsset)
        (bool success, ) = token.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        if (!success) {
            // If mint fails, try to transfer from pool balance
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256) {
        // For mocking, just return configured result
        return nextExchangeResult;
    }

    function get_dy_underlying(int128 i, int128 j, uint256 dx) external view returns (uint256) {
        return nextExchangeResult;
    }
}
