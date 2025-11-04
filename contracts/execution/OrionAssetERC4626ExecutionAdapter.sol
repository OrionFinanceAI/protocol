// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IExecutionAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";

/**
 * @title OrionAssetERC4626ExecutionAdapter
 * @notice Execution adapter for ERC-4626 vaults sharing the same underlying asset as the Orion protocol.
 * @author Orion Finance
 * @dev This adapter handles the conversion between underlying assets and vault shares.
 *      It is not safe to use this adapter with vaults that are based on a different asset.
 */
contract OrionAssetERC4626ExecutionAdapter is IExecutionAdapter {
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

    /// @notice Constructor
    /// @param configAddress The address of the Orion config contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        underlyingAsset = address(config.underlyingAsset());
        underlyingAssetToken = IERC20(underlyingAsset);
        liquidityOrchestrator = config.liquidityOrchestrator();
    }

    /// @notice Validates that the given asset is compatible with this adapter
    /// @param asset The address of the asset to validate
    function validateExecutionAdapter(address asset) external view override {
        try IERC4626(asset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != underlyingAsset) revert ErrorsLib.InvalidAdapter();
        } catch {
            revert ErrorsLib.InvalidAdapter(); // Adapter not valid for this vault
        }
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address vaultAsset,
        uint256 sharesAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 receivedUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);

        // Redeem shares to get underlying assets
        // slither-disable-next-line unused-return
        receivedUnderlyingAmount = vault.redeem(sharesAmount, msg.sender, msg.sender);
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address vaultAsset,
        uint256 sharesAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 spentUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);

        spentUnderlyingAmount = vault.previewMint(sharesAmount);

        // Pull underlying assets from the caller
        underlyingAssetToken.safeTransferFrom(msg.sender, address(this), spentUnderlyingAmount);

        // Approve vault to spend underlying assets
        underlyingAssetToken.forceApprove(vaultAsset, spentUnderlyingAmount);

        // Deposit underlying assets to get vault shares
        // Capture actual shares minted (may differ from sharesAmount due to rounding)
        uint256 actualSharesMinted = vault.deposit(spentUnderlyingAmount, address(this));

        // Clean up approval
        underlyingAssetToken.forceApprove(vaultAsset, 0);

        // Push all received shares to the caller
        IERC20(vaultAsset).safeTransfer(msg.sender, actualSharesMinted);
    }
}
