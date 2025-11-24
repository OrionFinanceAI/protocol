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

    /// @notice Slippage tolerance (in basis points, where 10000 = 100%)
    uint256 public slippageTolerance;

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != liquidityOrchestrator) revert ErrorsLib.NotAuthorized();
        _;
    }

    /// @notice Constructor
    /// @param configAddress The address of the Orion config contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        underlyingAssetToken = config.underlyingAsset();
        liquidityOrchestrator = config.liquidityOrchestrator();
        // Initialize slippage tolerance from liquidity orchestrator's target buffer ratio
        // This will be updated when setSlippageTolerance is called
        slippageTolerance = 0;
    }

    /// @notice Updates the slippage tolerance
    /// @param _slippageTolerance The new slippage tolerance in basis points
    /// @dev Only callable by the liquidity orchestrator
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyLiquidityOrchestrator {
        slippageTolerance = _slippageTolerance;
    }

    /// @notice Validates that the given asset is compatible with this adapter
    /// @param asset The address of the asset to validate
    /// @dev This function validates compatibility checks needed during setup:
    ///      1. Underlying asset matches expected one (cross-check)
    ///      2. Target asset implements IERC4626 interface (cross-check)
    ///      3. Token decimals match config (prevents API adaptation issues)
    ///      Note: totalAssets check is performed separately during buy/sell operations
    function validateExecutionAdapter(address asset) external view override {
        _validateAdapterCompatibility(asset);
    }

    /// @notice Internal function to validate adapter compatibility
    /// @param asset The address of the asset to validate
    function _validateAdapterCompatibility(address asset) internal view {
        // 1. Verify asset implements IERC4626 and has correct underlying
        try IERC4626(asset).asset() returns (address vaultUnderlyingAsset) {
            if (vaultUnderlyingAsset != address(underlyingAssetToken)) revert ErrorsLib.InvalidAdapter(asset);
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // 2. Verify tokenDecimals match between runtime and config
        uint8 configDecimals = config.getTokenDecimals(asset);
        try IERC20Metadata(asset).decimals() returns (uint8 runtimeDecimals) {
            if (runtimeDecimals != configDecimals) {
                revert ErrorsLib.DecimalsMismatch(asset, runtimeDecimals, configDecimals);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @notice Validates asset state before execution (called during buy/sell)
    /// @param asset The address of the asset to validate
    /// @dev Checks runtime state including totalAssets to prevent division by zero
    function _validateExecutionState(address asset) internal view {
        // Verify vault has non-zero total assets
        try IERC4626(asset).totalAssets() returns (uint256 totalAssets) {
            if (totalAssets == 0) {
                revert ErrorsLib.ZeroTotalAssets(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address vaultAsset,
        uint256 sharesAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 receivedUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);

        // Atomically validate all order generation assumptions
        _validateAdapterCompatibility(vaultAsset);
        _validateExecutionState(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);

        // Preview expected underlying amount
        uint256 previewedUnderlyingAmount = vault.previewRedeem(sharesAmount);

        // Redeem shares to get underlying assets
        // slither-disable-next-line unused-return
        receivedUnderlyingAmount = vault.redeem(sharesAmount, msg.sender, msg.sender);

        // Verify slippage is within tolerance (if slippage tolerance is set)
        if (slippageTolerance > 0) {
            uint256 minAcceptable = (previewedUnderlyingAmount * (10000 - slippageTolerance)) / 10000;
            if (receivedUnderlyingAmount < minAcceptable) {
                revert ErrorsLib.SlippageExceeded(vaultAsset, receivedUnderlyingAmount, previewedUnderlyingAmount);
            }
        }
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address vaultAsset,
        uint256 sharesAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 spentUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);
        _validateAdapterCompatibility(vaultAsset);
        _validateExecutionState(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        uint256 previewedUnderlyingAmount = vault.previewMint(sharesAmount);

        // Pull minimum of (allowance, LO's balance)
        uint256 approvedAmount = underlyingAssetToken.allowance(msg.sender, address(this));
        uint256 loBalance = underlyingAssetToken.balanceOf(msg.sender);
        uint256 maxAcceptableSpend = approvedAmount < loBalance ? approvedAmount : loBalance;
        underlyingAssetToken.safeTransferFrom(msg.sender, address(this), maxAcceptableSpend);

        // Approve vault for actual balance and mint shares
        uint256 adapterBalance = underlyingAssetToken.balanceOf(address(this));
        underlyingAssetToken.forceApprove(vaultAsset, adapterBalance);
        spentUnderlyingAmount = vault.mint(sharesAmount, address(this));

        // Verify slippage tolerance
        if (slippageTolerance > 0) {
            uint256 maxAcceptableForSlippage = (previewedUnderlyingAmount * (10000 + slippageTolerance)) / 10000;
            if (spentUnderlyingAmount > maxAcceptableForSlippage) {
                revert ErrorsLib.SlippageExceeded(vaultAsset, spentUnderlyingAmount, previewedUnderlyingAmount);
            }
        }

        underlyingAssetToken.forceApprove(vaultAsset, 0);

        // Return excess and transfer shares
        uint256 remainingBalance = underlyingAssetToken.balanceOf(address(this));
        if (remainingBalance > 0) {
            underlyingAssetToken.safeTransfer(msg.sender, remainingBalance);
        }
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
    }
}
