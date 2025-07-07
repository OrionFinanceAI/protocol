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
    /// @dev The caller (RebalancingEngine) should have approved this contract to spend the underlying assets
    ///      The resulting shares will be held by this contract and can be transferred to the caller
    function buy(address asset, uint256 amount) external override {
        if (asset != address(VAULT)) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(UNDERLYING_ASSET));

        // Transfer underlying assets from caller to this contract
        UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), amount);
        // TODO: message sender is engine, not liquidity orchestrator, how to handle this?

        // Approve vault to spend underlying assets
        UNDERLYING_ASSET.forceApprove(address(VAULT), amount);

        // Deposit underlying assets to get vault shares
        uint256 shares = VAULT.deposit(amount, msg.sender);

        // Clean up approval
        UNDERLYING_ASSET.forceApprove(address(VAULT), 0);

        // TODO: shares are sent directly to the caller (msg.sender),
        // how to handle internal accounting and share liquidity?
    }

    /// @notice Executes a sell operation by redeeming vault shares to get underlying assets
    /// @param asset The address of the asset to sell (should be the vault address)
    /// @param amount The amount of vault shares to redeem
    /// @dev The caller (RebalancingEngine) should have approved this contract to spend the vault shares
    ///      The resulting underlying assets will be transferred to the caller
    function sell(address asset, uint256 amount) external override {
        if (asset != address(VAULT)) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();

        // Transfer vault shares from caller to this contract
        bool success = VAULT.transferFrom(msg.sender, address(this), amount);
        if (!success) revert ErrorsLib.TransferFailed();
        // TODO: message sender is engine, not liquidity orchestrator, how to handle this?

        // Redeem shares to get underlying assets
        uint256 assets = VAULT.redeem(amount, msg.sender, address(this));

        // TODO: underlying assets are sent directly to the caller (msg.sender),
        // how to handle internal accounting and underlying asset liquidity?
    }
}
