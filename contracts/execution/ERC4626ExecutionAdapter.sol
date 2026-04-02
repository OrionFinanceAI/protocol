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

    /// @notice Orion protocol configuration contract
    IOrionConfig public immutable CONFIG;

    /// @notice Protocol underlying asset
    IERC20 public immutable UNDERLYING_ASSET;

    /// @notice Liquidity orchestrator contract
    ILiquidityOrchestrator public immutable LIQUIDITY_ORCHESTRATOR;

    /// @dev Restricts state-changing adapter functions to the liquidity orchestrator
    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(LIQUIDITY_ORCHESTRATOR)) revert ErrorsLib.NotAuthorized();
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

        if (address(LIQUIDITY_ORCHESTRATOR) == address(0)) revert ErrorsLib.ZeroAddress();
    }

    /// @notice Internal validation function that performs compatibility checks
    /// @param asset The address of the asset to validate
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
            // (vault underlying must be whitelisted in config)
            try IERC20Metadata(vaultUnderlying).decimals() returns (uint8 vaultUnderlyingDecimals) {
                if (vaultUnderlyingDecimals != CONFIG.getTokenDecimals(vaultUnderlying)) {
                    revert ErrorsLib.InvalidAdapter(asset);
                }
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
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
    function previewBuy(address vaultAsset, uint256 sharesAmount) external returns (uint256 underlyingAmount) {
        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();
        uint256 vaultUnderlyingNeeded = vault.previewMint(sharesAmount);

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            return vaultUnderlyingNeeded;
        }
        IExecutionAdapter swapExecutor = IExecutionAdapter(
            address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
        );
        return swapExecutor.previewBuy(vaultUnderlying, vaultUnderlyingNeeded);
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
        if (sharesAmount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(vaultAsset);
        _validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();
        uint256 vaultUnderlyingNeeded = vault.previewMint(sharesAmount);

        uint256 underlyingNeeded;
        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            underlyingNeeded = vaultUnderlyingNeeded;
        } else {
            underlyingNeeded = this.previewBuy(vaultAsset, sharesAmount);
        }

        // Pull previewed amount from the caller.
        UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), underlyingNeeded);

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            // Approve vault to spend underlying assets
            UNDERLYING_ASSET.forceApprove(vaultAsset, underlyingNeeded);

            // Mint exact shares. Vault will pull the required underlying amount
            // This guarantees sharesAmount shares are minted.
            spentUnderlyingAmount = vault.mint(sharesAmount, address(this));
            // Some ERC4626 implementations may leave dust in the adapter;
            // we accept that, as target shares are minted.

            // Clean up approval
            UNDERLYING_ASSET.forceApprove(vaultAsset, 0);
        } else {
            IExecutionAdapter swapExecutor = IExecutionAdapter(
                address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
            );
            // Approve swap executor to spend underlying assets
            UNDERLYING_ASSET.forceApprove(address(swapExecutor), underlyingNeeded);

            spentUnderlyingAmount = swapExecutor.buy(vaultUnderlying, vaultUnderlyingNeeded);
            // Swap Executor may leave dust in the adapter, we accept that.

            // Clean up approval
            UNDERLYING_ASSET.forceApprove(address(swapExecutor), 0);

            // Approve vault to spend vault underlying assets
            IERC20(vaultUnderlying).forceApprove(vaultAsset, vaultUnderlyingNeeded);

            // Mint exact shares. Vault will pull the required underlying amount
            // This guarantees sharesAmount shares are minted.
            // slither-disable-next-line unused-return
            vault.mint(sharesAmount, address(this));
            // Some ERC4626 implementations may leave dust in the adapter;
            // we accept that, as target shares are minted.

            // Clean up approval
            IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);
        }

        // Push all minted shares to the caller (LO)
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
    }
}
