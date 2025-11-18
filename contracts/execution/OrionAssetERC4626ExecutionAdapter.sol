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
        underlyingAssetToken = config.underlyingAsset();
        liquidityOrchestrator = config.liquidityOrchestrator();
    }

    /// @notice Validates that the given asset is compatible with this adapter
    /// @param asset The address of the asset to validate
    function validateExecutionAdapter(address asset) external view override {
        try IERC4626(asset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != address(underlyingAssetToken)) revert ErrorsLib.InvalidAdapter();
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

        // Preview the required underlying amount for minting exact shares
        uint256 previewedAmount = vault.previewMint(sharesAmount);

        // Pull previewed amount from the caller
        underlyingAssetToken.safeTransferFrom(msg.sender, address(this), previewedAmount);

        // Approve vault to spend underlying assets (with buffer for rounding)
        underlyingAssetToken.forceApprove(vaultAsset, type(uint256).max);

        // Mint exact shares - vault will pull the required underlying amount
        // This guarantees sharesAmount shares are minted, preventing accounting drift
        spentUnderlyingAmount = vault.mint(sharesAmount, address(this));

        // Clean up approval
        underlyingAssetToken.forceApprove(vaultAsset, 0);

        // Return any excess underlying back to the caller
        uint256 excessAmount = previewedAmount - spentUnderlyingAmount;
        if (excessAmount > 0) {
            underlyingAssetToken.safeTransfer(msg.sender, excessAmount);
        }

        // Push all minted shares to the caller
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
    }
}
