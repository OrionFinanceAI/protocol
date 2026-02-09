// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ISwapExecutor } from "../interfaces/ISwapExecutor.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ILiquidityOrchestrator } from "../interfaces/ILiquidityOrchestrator.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
/**
 * @title ERC4626ExecutionAdapter
 * @notice ERC4626 execution adapter that delegates swaps to token-specific swap executors
 * @author Orion Finance
 * @dev Architecture:
 * - Handles same-asset flows: USDC → vault (no swap)
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
contract ERC4626ExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Orion protocol configuration contract
    IOrionConfig public immutable CONFIG;

    /// @notice Protocol underlying asset (USDC)
    IERC20 public immutable UNDERLYING_ASSET;

    /// @notice Liquidity orchestrator contract
    ILiquidityOrchestrator public immutable LIQUIDITY_ORCHESTRATOR;

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(LIQUIDITY_ORCHESTRATOR)) {
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

        CONFIG = IOrionConfig(configAddress);
        LIQUIDITY_ORCHESTRATOR = ILiquidityOrchestrator(liquidityOrchestratorAddress);
        UNDERLYING_ASSET = IERC20(CONFIG.underlyingAsset());
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        // Verify asset is ERC4626 vault
        try IERC4626(asset).asset() returns (address vaultUnderlying) {
            // Verify vault decimals are registered
            try IERC20Metadata(asset).decimals() returns (uint8 vaultDecimals) {
                if (vaultDecimals != CONFIG.getTokenDecimals(asset)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
            }

            // For cross-asset vaults, verify swap executor exists for the underlying
            if (vaultUnderlying != address(UNDERLYING_ASSET)) {
                address swapExecutor = address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying));
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

    /// @notice Internal buy implementation with routing
    /// @param vaultAsset The ERC4626 vault asset to buy
    /// @param sharesAmount The amount of vault shares to mint
    /// @param routeParams Optional routing parameters for cross-asset swaps
    /// @return executionUnderlyingAmount The amount of protocol underlying spent
    function _buyInternal(
        address vaultAsset,
        uint256 sharesAmount,
        bytes memory routeParams
    ) internal returns (uint256 executionUnderlyingAmount) {
        // Validate asset
        this.validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        // Get max underlying from LO's allowance (includes slippage)
        uint256 maxUnderlying = UNDERLYING_ASSET.allowance(msg.sender, address(this));

        // Acquire vault underlying (either directly or via swap)
        (uint256 underlyingSpent, uint256 vaultUnderlyingReceived) = _acquireVaultUnderlying(
            vault,
            vaultUnderlying,
            sharesAmount,
            maxUnderlying,
            routeParams,
            vaultAsset
        );

        // Approve vault and mint exact shares
        IERC20(vaultUnderlying).forceApprove(vaultAsset, vaultUnderlyingReceived);

        // Mint exact shares requested
        // slither-disable-next-line unused-return
        vault.mint(sharesAmount, address(this));

        IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);

        // Transfer shares to LO
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);

        executionUnderlyingAmount = underlyingSpent;
    }

    /// @notice Acquires vault underlying either directly or via swap
    /// @param vault The ERC4626 vault
    /// @param vaultUnderlying The underlying asset of the vault
    /// @param sharesAmount The amount of shares to mint
    /// @param maxUnderlying Maximum underlying approved by LO
    /// @param routeParams Routing parameters for swap
    /// @param vaultAsset The vault asset address (for error reporting)
    /// @return underlyingSpent Amount of protocol underlying spent
    /// @return vaultUnderlyingReceived Amount of vault underlying acquired
    function _acquireVaultUnderlying(
        IERC4626 vault,
        address vaultUnderlying,
        uint256 sharesAmount,
        uint256 maxUnderlying,
        bytes memory routeParams,
        address vaultAsset
    ) internal returns (uint256 underlyingSpent, uint256 vaultUnderlyingReceived) {
        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            // Same-asset: no swap needed
            uint256 underlyingNeeded = vault.previewMint(sharesAmount);
            if (underlyingNeeded > maxUnderlying) {
                revert ErrorsLib.SlippageExceeded(vaultAsset, underlyingNeeded, maxUnderlying);
            }
            UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), underlyingNeeded);
            return (underlyingNeeded, underlyingNeeded);
        } else {
            // Cross-asset: swap USDC → vaultUnderlying
            UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), maxUnderlying);
            ISwapExecutor swapExecutor = ISwapExecutor(
                address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
            );
            if (address(swapExecutor) == address(0)) revert ErrorsLib.InvalidSwapExecutor();
            UNDERLYING_ASSET.forceApprove(address(swapExecutor), maxUnderlying);
            uint24 fee = routeParams.length > 0 ? abi.decode(routeParams, (uint24)) : 3000;
            uint256 underlyingNeeded = vault.previewMint(sharesAmount);
            underlyingSpent = swapExecutor.swapExactOutput(
                address(UNDERLYING_ASSET),
                vaultUnderlying,
                underlyingNeeded,
                maxUnderlying,
                abi.encode(fee)
            );
            UNDERLYING_ASSET.forceApprove(address(swapExecutor), 0);
            // Refund excess to LO
            uint256 unusedBalance = UNDERLYING_ASSET.balanceOf(address(this));
            if (unusedBalance > 0) {
                UNDERLYING_ASSET.safeTransfer(msg.sender, unusedBalance);
            }
            return (underlyingSpent, underlyingNeeded);
        }
    }

    /// @notice Internal sell implementation with routing
    /// @param vaultAsset The ERC4626 vault asset to sell
    /// @param sharesAmount The amount of vault shares to redeem
    /// @param routeParams Optional routing parameters for cross-asset swaps
    /// @return executionUnderlyingAmount The amount of protocol underlying received
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
        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            // Same-asset: no swap needed
            protocolUnderlyingReceived = underlyingReceived;
        } else {
            // Cross-asset: swap vaultUnderlying → USDC

            // Get swap executor for vault underlying from LO
            ISwapExecutor swapExecutor = ISwapExecutor(
                address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
            );
            if (address(swapExecutor) == address(0)) revert ErrorsLib.InvalidSwapExecutor();

            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), underlyingReceived);

            uint24 fee = routeParams.length > 0 ? abi.decode(routeParams, (uint24)) : 3000; // Default 0.3%

            // Use swap executor interface to perform swap
            protocolUnderlyingReceived = swapExecutor.swapExactInput(
                vaultUnderlying,
                address(UNDERLYING_ASSET),
                underlyingReceived,
                0, // LO validates final amount
                abi.encode(fee)
            );

            // Clean up approval
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), 0);
        }

        // Transfer protocol underlying to LO
        UNDERLYING_ASSET.safeTransfer(msg.sender, protocolUnderlyingReceived);

        executionUnderlyingAmount = protocolUnderlyingReceived;
    }
}
