// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

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
 * @notice Execution adapter for ERC-4626 vaults with generic underlying asset.
 * @author Orion Finance
 * @dev Architecture:
 * - Handles same-asset flows: protocolUnderlying=vaultUnderlying → vaultShares
 * - Handles cross-asset flows: protocolUnderlying → ExecutionAdapter → vaultUnderlying → vaultShares
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626ExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Orion protocol configuration contract
    IOrionConfig public immutable CONFIG;

    /// @notice Protocol underlying asset
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
     */
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        CONFIG = IOrionConfig(configAddress);
        UNDERLYING_ASSET = IERC20(CONFIG.underlyingAsset());
        LIQUIDITY_ORCHESTRATOR = ILiquidityOrchestrator(CONFIG.liquidityOrchestrator());
    }

    function _validateExecutionAdapter(address asset) internal view {
        // 1. Verify asset implements IERC4626
        try IERC4626(asset).asset() returns (address vaultUnderlying) {
            // 2. Verify registered vault decimals match config decimals
            try IERC20Metadata(asset).decimals() returns (uint8 vaultDecimals) {
                if (vaultDecimals != CONFIG.getTokenDecimals(asset)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
            }

            // 3. Verify underlying vault decimals match config decimals
            try IERC20Metadata(vaultUnderlying).decimals() returns (uint8 vaultUnderlyingDecimals) {
                if (vaultUnderlyingDecimals != CONFIG.getTokenDecimals(vaultUnderlying)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
            }

            // 4. For cross-asset vaults, verify swap executor exists for the underlying
            if (vaultUnderlying != address(UNDERLYING_ASSET)) {
                if (address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying)) == address(0)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            }
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
        uint256 sharesAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 receivedUnderlyingAmount) {
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);
        // Atomically validate order generation assumptions
        _validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            receivedUnderlyingAmount = vault.redeem(sharesAmount, msg.sender, msg.sender);
        } else {
            uint256 receivedVaultUnderlyingAmount = vault.redeem(sharesAmount, address(this), msg.sender);

            IExecutionAdapter swapExecutor = IExecutionAdapter(
                address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
            );

            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), receivedVaultUnderlyingAmount);

            receivedUnderlyingAmount = swapExecutor.sell(vaultUnderlying, receivedVaultUnderlyingAmount);

            // Clean up approval
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), 0);

            UNDERLYING_ASSET.safeTransfer(msg.sender, receivedUnderlyingAmount);
        }
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address vaultAsset,
        uint256 sharesAmount
    ) external override onlyLiquidityOrchestrator returns (uint256 spentUnderlyingAmount) {
        // Validate asset
        _validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            // Preview the required underlying amount for minting exact shares
            uint256 previewedUnderlyingAmount = vault.previewMint(sharesAmount);

            // Pull previewed amount from the caller
            UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), previewedUnderlyingAmount);

            // Approve vault to spend underlying assets
            UNDERLYING_ASSET.forceApprove(vaultAsset, previewedUnderlyingAmount);

            // Mint exact shares. Vault will pull the required underlying amount
            // This guarantees sharesAmount shares are minted.
            spentUnderlyingAmount = vault.mint(sharesAmount, address(this));
            // Some ERC4626 implementations may leave dust in the adapter;
            // we accept that, as target shares are minted.

            // Clean up approval
            UNDERLYING_ASSET.forceApprove(vaultAsset, 0);

            // Push all minted shares to the caller (LO)
            IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
        } else {
            // TODO. Implement this case.
            // // Cross-asset: swap USDC → vaultUnderlying
            // UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), maxUnderlying);
            // IExecutionAdapter swapExecutor = IExecutionAdapter(
            //     address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
            // );
            // UNDERLYING_ASSET.forceApprove(address(swapExecutor), maxUnderlying);
            // uint24 fee = routeParams.length > 0 ? abi.decode(routeParams, (uint24)) : 3000;
            // uint256 underlyingNeeded = vault.previewMint(sharesAmount);
            // underlyingSpent = swapExecutor.swapExactOutput(
            //     address(UNDERLYING_ASSET),
            //     vaultUnderlying,
            //     underlyingNeeded,
            //     maxUnderlying,
            //     abi.encode(fee)
            // );
            // UNDERLYING_ASSET.forceApprove(address(swapExecutor), 0);
            // // Refund excess to LO
            // uint256 unusedBalance = UNDERLYING_ASSET.balanceOf(address(this));
            // if (unusedBalance > 0) {
            //     UNDERLYING_ASSET.safeTransfer(msg.sender, unusedBalance);
            // }
        }

        // TODO: assess below logic/extract common components in if else above.

        // // Approve vault and mint exact shares
        // IERC20(vaultUnderlying).forceApprove(vaultAsset, vaultUnderlyingReceived);

        // // Mint exact shares requested
        // // slither-disable-next-line unused-return
        // vault.mint(sharesAmount, address(this));

        // IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);

        // // Transfer shares to LO
        // IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);

        // executionUnderlyingAmount = underlyingSpent;
    }
}
