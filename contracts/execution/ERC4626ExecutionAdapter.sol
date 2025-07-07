// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IExecutionAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ERC4626 Execution Adapter
/// @notice Adapter for executing buy/sell operations on ERC4626 vaults
/// @dev This adapter handles the conversion between underlying assets and vault shares
///      - Buy: Deposits underlying assets into the vault to receive shares
///      - Sell: Redeems shares from the vault to receive underlying assets
///      The adapter expects funds to be transferred to it before executing trades
///      and returns the results to the caller (LiquidityOrchestrator).
contract ERC4626ExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;

    /// @notice The ERC4626 vault this adapter interacts with
    IERC4626 public immutable VAULT;

    /// @notice The underlying asset of the vault
    IERC20 public immutable UNDERLYING_ASSET;

    /// @param _vault The ERC4626 vault address
    constructor(address _vault) {
        if (_vault == address(0)) revert ErrorsLib.ZeroAddress();
        VAULT = IERC4626(_vault);
        UNDERLYING_ASSET = IERC20(VAULT.asset());
    }

    /// @notice Executes a buy operation by depositing underlying assets to get vault shares
    /// @param asset The address of the asset to buy (should be the vault address)
    /// @param amount The amount of underlying assets to deposit
    /// @dev The caller (LiquidityOrchestrator) should have transferred the underlying assets
    ///      to this contract before calling this function. The resulting shares will be
    ///      transferred back to the caller.
    function buy(address asset, uint256 amount) external override {
        if (asset != address(VAULT)) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(UNDERLYING_ASSET));

        // Verify we have the expected underlying assets
        uint256 contractBalance = UNDERLYING_ASSET.balanceOf(address(this));
        if (contractBalance < amount) revert ErrorsLib.AmountMustBeGreaterThanZero(address(UNDERLYING_ASSET));

        // Approve vault to spend underlying assets
        UNDERLYING_ASSET.forceApprove(address(VAULT), amount);

        // Deposit underlying assets to get vault shares
        uint256 shares = VAULT.deposit(amount, address(this));

        // Clean up approval
        UNDERLYING_ASSET.forceApprove(address(VAULT), 0);

        // Transfer the received shares back to the caller (LiquidityOrchestrator)
        bool success = VAULT.transfer(msg.sender, shares);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Executes a sell operation by redeeming vault shares to get underlying assets
    /// @param asset The address of the asset to sell (should be the vault address)
    /// @param amount The amount of vault shares to redeem
    /// @dev The caller (LiquidityOrchestrator) should have transferred the vault shares
    ///      to this contract before calling this function. The resulting underlying assets
    ///      will be transferred back to the caller.
    function sell(address asset, uint256 amount) external override {
        if (asset != address(VAULT)) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();

        // Verify we have the expected vault shares
        uint256 contractBalance = VAULT.balanceOf(address(this));
        if (contractBalance < amount) revert ErrorsLib.SharesMustBeGreaterThanZero();

        // Redeem shares to get underlying assets
        uint256 assets = VAULT.redeem(amount, address(this), address(this));

        // Transfer the received underlying assets back to the caller (LiquidityOrchestrator)
        bool success = UNDERLYING_ASSET.transfer(msg.sender, assets);
        if (!success) revert ErrorsLib.TransferFailed();
    }
}
