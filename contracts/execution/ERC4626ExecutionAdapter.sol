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
contract ERC4626ExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;

    /// @notice The ERC4626 vault this adapter interacts with
    IERC4626 public immutable vault;

    /// @notice The underlying asset of the vault
    IERC20 public immutable underlyingAsset;

    /// @param _vault The ERC4626 vault address
    constructor(address _vault) {
        if (_vault == address(0)) revert ErrorsLib.ZeroAddress();
        vault = IERC4626(_vault);
        underlyingAsset = IERC20(vault.asset());
    }

    /// @notice Executes a buy operation by depositing underlying assets to get vault shares
    /// @param asset The address of the asset to buy (should be the vault address)
    /// @param amount The amount of underlying assets to deposit
    /// @dev The caller (RebalancingEngine) should have approved this contract to spend the underlying assets
    ///      The resulting shares will be held by this contract and can be transferred to the caller
    function buy(address asset, uint256 amount) external override {
        if (asset != address(vault)) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(underlyingAsset));

        // Transfer underlying assets from caller to this contract
        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);

        // Approve vault to spend underlying assets
        underlyingAsset.forceApprove(address(vault), amount);

        // Deposit underlying assets to get vault shares
        uint256 shares = vault.deposit(amount, msg.sender);

        // Clean up approval
        underlyingAsset.forceApprove(address(vault), 0);

        // Note: shares are sent directly to the caller (msg.sender)
        // The vault's deposit function handles the share minting to the specified receiver
    }

    /// @notice Executes a sell operation by redeeming vault shares to get underlying assets
    /// @param asset The address of the asset to sell (should be the vault address)
    /// @param amount The amount of vault shares to redeem
    /// @dev The caller (RebalancingEngine) should have approved this contract to spend the vault shares
    ///      The resulting underlying assets will be transferred to the caller
    function sell(address asset, uint256 amount) external override {
        if (asset != address(vault)) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();

        // Transfer vault shares from caller to this contract
        vault.transferFrom(msg.sender, address(this), amount);

        // Redeem shares to get underlying assets
        uint256 assets = vault.redeem(amount, msg.sender, address(this));

        // Note: underlying assets are sent directly to the caller (msg.sender)
        // The vault's redeem function handles the asset transfer to the specified receiver
    }
}
