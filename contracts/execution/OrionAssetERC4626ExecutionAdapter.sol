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
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";

/**
 * @title OrionAssetERC4626ExecutionAdapter
 * @notice Execution adapter for ERC-4626 vaults sharing the same underlying asset as the Orion protocol.
 * @dev This adapter handles the conversion between underlying assets and vault shares.
 *      It is not safe to use this adapter with vaults that are based on a different asset.
 */
contract OrionAssetERC4626ExecutionAdapter is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    IExecutionAdapter
{
    using SafeERC20 for IERC20;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice The underlying asset as an IERC20 interface
    IERC20 public underlyingAssetToken;

    /// @param initialOwner The address of the initial owner
    function initialize(address initialOwner, address _configAddress) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        if (_configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        underlyingAsset = address(IOrionConfig(_configAddress).underlyingAsset());
        underlyingAssetToken = IERC20(underlyingAsset);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Executes a buy operation by depositing underlying assets to get vault shares
    /// @param vaultAsset The address of the vault to buy
    /// @param amount The amount of underlying assets to deposit
    /// @dev The adapter will pull the underlying assets from the caller (LiquidityOrchestrator)
    ///      and push the resulting shares.
    function buy(address vaultAsset, uint256 amount) external override {
        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlyingAsset = vault.asset();
        if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        // Pull underlying assets from the caller (LiquidityOrchestrator)
        underlyingAssetToken.safeTransferFrom(msg.sender, address(this), amount);
        // Approve vault to spend underlying assets
        underlyingAssetToken.forceApprove(vaultAsset, amount);
        // Deposit underlying assets to get vault shares
        uint256 shares = vault.deposit(amount, address(this));
        // Clean up approval
        underlyingAssetToken.forceApprove(vaultAsset, 0);

        // Push the received shares to the caller (LiquidityOrchestrator)
        bool success = vault.transfer(msg.sender, shares);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Executes a sell operation by redeeming vault shares to get underlying assets
    /// @param vaultAsset The address of the vault to sell
    /// @param amount The amount of vault shares to redeem
    /// @dev The adapter will pull the vault shares from the caller (LiquidityOrchestrator)
    ///      and push the resulting underlying assets.
    function sell(address vaultAsset, uint256 amount) external override {
        address vaultUnderlyingAsset = IERC4626(vaultAsset).asset();
        if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        IERC20 vault = IERC20(vaultAsset);
        // Pull vault shares from the caller (LiquidityOrchestrator)
        vault.safeTransferFrom(msg.sender, address(this), amount);
        // Approve vault to spend shares
        vault.forceApprove(vaultAsset, amount);
        // Redeem shares to get underlying assets
        uint256 assets = IERC4626(vaultAsset).redeem(amount, address(this), address(this));
        // Clean up approval
        vault.forceApprove(vaultAsset, 0);

        // Push the received underlying assets to the caller (LiquidityOrchestrator)
        bool success = underlyingAssetToken.transfer(msg.sender, assets);
        if (!success) revert ErrorsLib.TransferFailed();
    }
}
