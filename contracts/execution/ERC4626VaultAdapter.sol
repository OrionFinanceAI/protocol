// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ISwapExecutor } from "../interfaces/ISwapExecutor.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ILiquidityOrchestrator } from "../interfaces/ILiquidityOrchestrator.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
/**
 * @title ERC4626VaultAdapter
 * @notice ERC4626 vault adapter that delegates swaps to token-specific swap executors
 * @author Orion Finance
 * @dev Architecture:
 * - Handles same-asset flows: USDC → USDC vault (no swap)
 * - Handles cross-asset flows: USDC → SwapExecutor → underlying → vault
 * - Gets swap executor from LO's executionAdapterOf[vaultUnderlying]
 *
 * Example setup:
 * - WETH token → UniswapV3TokenSwapExecutor (for USDC/WETH swaps)
 * - WETH vault → This adapter (for vault operations)
 * - This adapter calls executionAdapterOf[WETH] to get swap executor for swaps
 *
 * Security:
 * - Only LiquidityOrchestrator can call buy/sell
 * - All approvals are transient and zeroed after use
 * - Refunds unused input tokens to caller
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626VaultAdapter is IExecutionAdapter, ISwapExecutor {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Orion protocol configuration contract
    IOrionConfig public immutable config;

    /// @notice Protocol underlying asset (USDC)
    IERC20 public immutable underlyingAsset;

    /// @notice Liquidity orchestrator contract
    ILiquidityOrchestrator public immutable liquidityOrchestrator;

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) {
            revert ErrorsLib.NotAuthorized();
        }
        _;
    }

    /**
     * @notice Constructor
     * @param configAddress OrionConfig contract address
     * @param liquidityOrchestratorAddress LiquidityOrchestrator contract address
     */
    constructor(address configAddress, address liquidityOrchestratorAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (liquidityOrchestratorAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        liquidityOrchestrator = ILiquidityOrchestrator(liquidityOrchestratorAddress);
        underlyingAsset = IERC20(config.underlyingAsset());
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        // Verify asset is ERC4626 vault
        try IERC4626(asset).asset() returns (address vaultUnderlying) {
            // Verify vault decimals are registered
            try IERC20Metadata(asset).decimals() returns (uint8 vaultDecimals) {
                if (vaultDecimals != config.getTokenDecimals(asset)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
            }

            // For cross-asset vaults, verify swap executor exists for the underlying
            if (vaultUnderlying != address(underlyingAsset)) {
                address swapExecutor = address(liquidityOrchestrator.executionAdapterOf(vaultUnderlying));
                if (swapExecutor == address(0)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 /* estimatedUnderlyingAmount */
    ) external override onlyLiquidityOrchestrator returns (uint256 executionUnderlyingAmount) {
        return _buyInternal(vaultAsset, sharesAmount, "");
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 /* estimatedUnderlyingAmount */
    ) external override onlyLiquidityOrchestrator returns (uint256 executionUnderlyingAmount) {
        return _sellInternal(vaultAsset, sharesAmount, "");
    }

    /// @dev Internal buy implementation with routing
    function _buyInternal(
        address vaultAsset,
        uint256 sharesAmount,
        bytes memory routeParams
    ) internal returns (uint256 executionUnderlyingAmount) {
        // Validate asset
        this.validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        // Calculate underlying needed for exact shares
        uint256 underlyingNeeded = vault.previewMint(sharesAmount);

        // Get max underlying from LO's allowance (includes slippage)
        uint256 maxUnderlying = underlyingAsset.allowance(msg.sender, address(this));

        uint256 underlyingSpentOnSwap = 0;

        // Handle same-asset vs cross-asset scenarios
        if (vaultUnderlying == address(underlyingAsset)) {
            // Same-asset: no swap needed
            underlyingAsset.safeTransferFrom(msg.sender, address(this), underlyingNeeded);
            underlyingSpentOnSwap = underlyingNeeded;
        } else {
            // Cross-asset: swap USDC → vaultUnderlying
            underlyingAsset.safeTransferFrom(msg.sender, address(this), maxUnderlying);

            // Get swap executor for vault underlying from LO
            ISwapExecutor swapExecutor = ISwapExecutor(
                address(liquidityOrchestrator.executionAdapterOf(vaultUnderlying))
            );
            if (address(swapExecutor) == address(0)) revert ErrorsLib.InvalidSwapExecutor();

            // Approve and execute swap
            underlyingAsset.forceApprove(address(swapExecutor), maxUnderlying);

            uint24 fee = routeParams.length > 0 ? abi.decode(routeParams, (uint24)) : 3000; // Default 0.3%

            // Use swap executor interface to perform swap
            underlyingSpentOnSwap = swapExecutor.swapExactOutput(
                address(underlyingAsset),
                vaultUnderlying,
                underlyingNeeded,
                maxUnderlying,
                abi.encode(fee)
            );

            // Clean up approval
            underlyingAsset.forceApprove(address(swapExecutor), 0);

            // Refund excess to LO
            uint256 unusedBalance = underlyingAsset.balanceOf(address(this));
            if (unusedBalance > 0) {
                underlyingAsset.safeTransfer(msg.sender, unusedBalance);
            }
        }

        // Approve vault and mint shares
        IERC20(vaultUnderlying).forceApprove(vaultAsset, underlyingNeeded);
        vault.mint(sharesAmount, address(this));
        IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);

        // Transfer shares to LO
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);

        executionUnderlyingAmount = underlyingSpentOnSwap;
    }

    /// @dev Internal sell implementation with routing
    function _sellInternal(
        address vaultAsset,
        uint256 sharesAmount,
        bytes memory routeParams
    ) internal returns (uint256 executionUnderlyingAmount) {
        // Validate asset
        this.validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        // Redeem vault shares
        uint256 underlyingReceived = vault.redeem(sharesAmount, address(this), msg.sender);

        uint256 protocolUnderlyingReceived = 0;

        // Handle same-asset vs cross-asset scenarios
        if (vaultUnderlying == address(underlyingAsset)) {
            // Same-asset: no swap needed
            protocolUnderlyingReceived = underlyingReceived;
        } else {
            // Cross-asset: swap vaultUnderlying → USDC

            // Get swap executor for vault underlying from LO
            ISwapExecutor swapExecutor = ISwapExecutor(
                address(liquidityOrchestrator.executionAdapterOf(vaultUnderlying))
            );
            if (address(swapExecutor) == address(0)) revert ErrorsLib.InvalidSwapExecutor();

            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), underlyingReceived);

            uint24 fee = routeParams.length > 0 ? abi.decode(routeParams, (uint24)) : 3000; // Default 0.3%

            // Use swap executor interface to perform swap
            protocolUnderlyingReceived = swapExecutor.swapExactInput(
                vaultUnderlying,
                address(underlyingAsset),
                underlyingReceived,
                0, // LO validates final amount
                abi.encode(fee)
            );

            // Clean up approval
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), 0);
        }

        // Transfer protocol underlying to LO
        underlyingAsset.safeTransfer(msg.sender, protocolUnderlyingReceived);

        executionUnderlyingAmount = protocolUnderlyingReceived;
    }

    /// @inheritdoc ISwapExecutor
    /// @dev This function is intentionally not implemented for vault adapters.
    ///      Swap functionality should be provided by dedicated swap executor contracts.
    ///      Vault adapters delegate to swap executors via executionAdapterOf mapping.
    function swapExactOutput(
        address /* tokenIn */,
        address /* tokenOut */,
        uint256 /* amountOut */,
        uint256 /* amountInMax */,
        bytes calldata /* routeParams */
    ) external pure returns (uint256) {
        revert("Use dedicated swap executor");
    }

    /// @inheritdoc ISwapExecutor
    /// @dev This function is intentionally not implemented for vault adapters.
    ///      Swap functionality should be provided by dedicated swap executor contracts.
    ///      Vault adapters delegate to swap executors via executionAdapterOf mapping.
    function swapExactInput(
        address /* tokenIn */,
        address /* tokenOut */,
        uint256 /* amountIn */,
        uint256 /* amountOutMin */,
        bytes calldata /* routeParams */
    ) external pure returns (uint256) {
        revert("Use dedicated swap executor");
    }
}
