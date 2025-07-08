// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
contract ERC4626ExecutionAdapter is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IExecutionAdapter {
    using SafeERC20 for IERC20;

    /// @param initialOwner The address of the initial owner
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Executes a buy operation by depositing underlying assets to get vault shares
    /// @param asset The address of the asset to buy (should be the vault address)
    /// @param amount The amount of underlying assets to deposit
    /// @dev The adapter will pull the underlying assets from the caller (LiquidityOrchestrator)
    ///      and transfer the resulting shares back to the caller.
    function buy(address asset, uint256 amount) external override {
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset);
        IERC4626 vault = IERC4626(asset);
        IERC20 underlyingAsset = IERC20(vault.asset());

        // Pull underlying assets from the caller (LiquidityOrchestrator)
        underlyingAsset.safeTransferFrom(msg.sender, address(this), amount);

        // Approve vault to spend underlying assets
        underlyingAsset.forceApprove(address(vault), amount);

        // Deposit underlying assets to get vault shares
        uint256 shares = vault.deposit(amount, address(this));

        // Transfer the received shares back to the caller (LiquidityOrchestrator)
        bool success = vault.transfer(msg.sender, shares);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Executes a sell operation by redeeming vault shares to get underlying assets
    /// @param asset The address of the asset to sell (should be the vault address)
    /// @param amount The amount of vault shares to redeem
    /// @dev The adapter will pull the vault shares from the caller (LiquidityOrchestrator)
    ///      and transfer the resulting underlying assets back to the caller.
    function sell(address asset, uint256 amount) external override {
        if (amount == 0) revert ErrorsLib.SharesMustBeGreaterThanZero();

        // Pull vault shares from the caller (LiquidityOrchestrator)
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // Approve vault to spend shares
        IERC20(asset).forceApprove(asset, amount);

        // Redeem shares to get underlying assets
        uint256 assets = IERC4626(asset).redeem(amount, address(this), address(this));

        // Clean up approval
        IERC20(asset).forceApprove(asset, 0);

        // Get the underlying asset address
        address underlyingAsset = IERC4626(asset).asset();

        // Transfer the received underlying assets back to the caller (LiquidityOrchestrator)
        bool success = IERC20(underlyingAsset).transfer(msg.sender, assets);
        if (!success) revert ErrorsLib.TransferFailed();
    }
}
