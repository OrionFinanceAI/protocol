// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IExecutionAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ILiquidityOrchestrator } from "../interfaces/ILiquidityOrchestrator.sol";

/**
 * @title OrionAssetERC4626ExecutionAdapter
 * @notice Execution adapter for ERC-4626 vaults sharing the same underlying asset as the Orion protocol.
 * @author Orion Finance
 * @dev This adapter handles the conversion between underlying assets and vault shares.
 *      It is not safe to use this adapter with vaults that are based on a different asset.
 */
contract OrionAssetERC4626ExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Basis points factor
    uint16 public constant BASIS_POINTS_FACTOR = 10_000;

    /// @notice The Orion config contract
    IOrionConfig public config;

    /// @notice The underlying asset as an IERC20 interface
    IERC20 public underlyingAssetToken;

    /// @notice The address of the liquidity orchestrator
    ILiquidityOrchestrator public liquidityOrchestrator;

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor
    /// @param configAddress The address of the Orion config contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        underlyingAssetToken = config.underlyingAsset();
        liquidityOrchestrator = ILiquidityOrchestrator(config.liquidityOrchestrator());
    }

    /// @notice Internal validation function that performs compatibility checks
    /// @param asset The address of the asset to validate
    function _validateExecutionAdapter(address asset) internal view {
        // 1. Verify asset implements IERC4626 and has correct underlying
        try IERC4626(asset).asset() returns (address underlying) {
            if (underlying != address(underlyingAssetToken)) revert ErrorsLib.InvalidAdapter(asset);
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // 2. Verify tokenDecimals match between runtime and config
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != config.getTokenDecimals(asset)) revert ErrorsLib.InvalidAdapter(asset);
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        _validateExecutionAdapter(asset);
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 receivedUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);
        // Atomically validate all order generation assumptions
        _validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);

        // Redeem shares to get underlying assets
        // slither-disable-next-line unused-return
        receivedUnderlyingAmount = vault.redeem(sharesAmount, msg.sender, msg.sender);

        if (receivedUnderlyingAmount < estimatedUnderlyingAmount) {
            uint256 maxUnderlyingAmount = estimatedUnderlyingAmount.mulDiv(
                BASIS_POINTS_FACTOR - liquidityOrchestrator.slippageTolerance(),
                BASIS_POINTS_FACTOR
            );
            if (receivedUnderlyingAmount < maxUnderlyingAmount) {
                revert ErrorsLib.SlippageExceeded(vaultAsset, receivedUnderlyingAmount, estimatedUnderlyingAmount);
            }
        }
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 spentUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);
        // Atomically validate all order generation assumptions
        _validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);

        // Preview the required underlying amount for minting exact shares
        uint256 previewedUnderlyingAmount = vault.previewMint(sharesAmount);

        if (previewedUnderlyingAmount > estimatedUnderlyingAmount) {
            uint256 maxUnderlyingAmount = estimatedUnderlyingAmount.mulDiv(
                BASIS_POINTS_FACTOR + liquidityOrchestrator.slippageTolerance(),
                BASIS_POINTS_FACTOR
            );
            if (previewedUnderlyingAmount > maxUnderlyingAmount) {
                revert ErrorsLib.SlippageExceeded(vaultAsset, previewedUnderlyingAmount, estimatedUnderlyingAmount);
            }
        }

        // Pull previewed amount from the caller
        underlyingAssetToken.safeTransferFrom(msg.sender, address(this), previewedUnderlyingAmount);

        // Approve vault to spend underlying assets
        underlyingAssetToken.forceApprove(vaultAsset, previewedUnderlyingAmount);

        // Mint exact shares. Vault will pull the required underlying amount
        // This guarantees sharesAmount shares are minted.
        spentUnderlyingAmount = vault.mint(sharesAmount, address(this));

        if (spentUnderlyingAmount != previewedUnderlyingAmount) revert ErrorsLib.ExecutionFailed(vaultAsset);

        // Clean up approval
        underlyingAssetToken.forceApprove(vaultAsset, 0);

        // Push all minted shares to the caller (LO)
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
    }
}
