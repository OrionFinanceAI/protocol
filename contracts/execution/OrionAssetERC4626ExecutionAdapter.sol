// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
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
contract OrionAssetERC4626ExecutionAdapter is Ownable, IExecutionAdapter {
    using SafeERC20 for IERC20;

    /// @notice The Orion config contract
    IOrionConfig public config;

    /// @notice Underlying asset address
    address public underlyingAsset;

    /// @notice The underlying asset as an IERC20 interface
    IERC20 public underlyingAssetToken;

    /// @notice The address of the liquidity orchestrator
    address public liquidityOrchestrator;

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != liquidityOrchestrator) revert ErrorsLib.UnauthorizedAccess();
        _;
    }

    /// @param initialOwner The address of the initial owner
    /// @param configAddress The address of the Orion config contract
    constructor(address initialOwner, address configAddress) Ownable(initialOwner) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        updateFromConfig();
    }

    /// @notice Executes a buy operation by depositing underlying assets to get vault shares
    /// @param vaultAsset The address of the vault to buy
    /// @param amount The amount of underlying assets to deposit
    /// @dev The adapter will pull the underlying assets from the caller
    ///      and push the resulting shares.
    function buy(address vaultAsset, uint256 amount) external override onlyLiquidityOrchestrator {
        try IERC4626(vaultAsset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();
        } catch {
            revert ErrorsLib.InvalidAsset(); // Not a valid ERC4626 vault
        }
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);

        // Pull underlying assets from the caller
        underlyingAssetToken.safeTransferFrom(msg.sender, address(this), amount);
        // Approve vault to spend underlying assets
        underlyingAssetToken.forceApprove(vaultAsset, amount);
        // Deposit underlying assets to get vault shares
        uint256 shares = vault.deposit(amount, address(this));
        // Clean up approval
        underlyingAssetToken.forceApprove(vaultAsset, 0);

        // Push the received shares to the caller
        bool success = vault.transfer(msg.sender, shares);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Executes a sell operation by redeeming vault shares to get underlying assets
    /// @param vaultAsset The address of the vault to sell
    /// @param amount The amount of vault shares to redeem
    /// @dev The adapter will pull the vault shares from the caller
    ///      and push the resulting underlying assets.
    function sell(address vaultAsset, uint256 amount) external override onlyLiquidityOrchestrator {
        try IERC4626(vaultAsset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAsset();
        } catch {
            revert ErrorsLib.InvalidAsset(); // Not a valid ERC4626 vault
        }
        if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        IERC20 vault = IERC20(vaultAsset);

        // Pull vault shares from the caller
        vault.safeTransferFrom(msg.sender, address(this), amount);
        // Approve vault to spend shares
        vault.forceApprove(vaultAsset, amount);
        // Redeem shares to get underlying assets
        uint256 assets = IERC4626(vaultAsset).redeem(amount, address(this), address(this));
        // Clean up approval
        vault.forceApprove(vaultAsset, 0);

        // Push the received underlying assets to the caller
        bool success = underlyingAssetToken.transfer(msg.sender, assets);
        if (!success) revert ErrorsLib.TransferFailed();
    }

    /// @notice Updates the adapter from the config contract
    /// @dev This function is called by the owner to update the adapter
    ///      when the config contract is updated.
    function updateFromConfig() public onlyOwner {
        underlyingAsset = address(config.underlyingAsset());
        underlyingAssetToken = IERC20(underlyingAsset);
        liquidityOrchestrator = config.liquidityOrchestrator();
    }
}
