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

    /// @notice Validates that an asset is a properly configured ERC4626 vault
    /// @param asset The vault asset address to validate
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
    function previewBuy(address vaultAsset, uint256 sharesAmount) external returns (uint256 underlyingAmount) {
        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();
        uint256 vaultUnderlyingNeeded = vault.previewMint(sharesAmount);

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            return vaultUnderlyingNeeded;
        } else {
            IExecutionAdapter swapExecutor = IExecutionAdapter(
                address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
            );
            return swapExecutor.previewBuy(vaultUnderlying, vaultUnderlyingNeeded);
        }
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
        _validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        if (vaultUnderlying == address(UNDERLYING_ASSET)) {
            spentUnderlyingAmount = _buySameAsset(vault, vaultAsset, sharesAmount);
        } else {
            spentUnderlyingAmount = _buyCrossAsset(vault, vaultAsset, vaultUnderlying, sharesAmount);
        }
    }

    /// @notice Same-asset buy: protocolUnderlying → vault shares (no swap needed)
    /// @param vault The ERC4626 vault contract
    /// @param vaultAsset The vault address
    /// @param sharesAmount The number of vault shares to mint
    /// @return spentUnderlyingAmount The underlying amount spent
    function _buySameAsset(
        IERC4626 vault,
        address vaultAsset,
        uint256 sharesAmount
    ) private returns (uint256 spentUnderlyingAmount) {
        uint256 previewedUnderlyingAmount = vault.previewMint(sharesAmount);

        UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), previewedUnderlyingAmount);
        UNDERLYING_ASSET.forceApprove(vaultAsset, previewedUnderlyingAmount);

        // Mint exact shares; vault pulls the required underlying.
        // Some ERC4626 implementations may leave dust — we accept that.
        spentUnderlyingAmount = vault.mint(sharesAmount, address(this));

        UNDERLYING_ASSET.forceApprove(vaultAsset, 0);
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
    }

    /// @notice Cross-asset buy: protocolUnderlying → swap executor → vaultUnderlying → vault shares
    /// @param vault The ERC4626 vault contract
    /// @param vaultAsset The vault address
    /// @param vaultUnderlying The vault's underlying token address
    /// @param sharesAmount The number of vault shares to mint
    /// @return spentUnderlyingAmount The underlying amount spent
    function _buyCrossAsset(
        IERC4626 vault,
        address vaultAsset,
        address vaultUnderlying,
        uint256 sharesAmount
    ) private returns (uint256 spentUnderlyingAmount) {
        uint256 vaultUnderlyingNeeded = vault.previewMint(sharesAmount);

        IExecutionAdapter swapExecutor = IExecutionAdapter(
            address(LIQUIDITY_ORCHESTRATOR.executionAdapterOf(vaultUnderlying))
        );

        // Pull exact input based on atomic preview
        uint256 underlyingNeeded = swapExecutor.previewBuy(vaultUnderlying, vaultUnderlyingNeeded);
        UNDERLYING_ASSET.safeTransferFrom(msg.sender, address(this), underlyingNeeded);
        UNDERLYING_ASSET.forceApprove(address(swapExecutor), underlyingNeeded);

        spentUnderlyingAmount = swapExecutor.buy(vaultUnderlying, vaultUnderlyingNeeded);
        UNDERLYING_ASSET.forceApprove(address(swapExecutor), 0);

        // Approve vault and mint exact shares
        IERC20(vaultUnderlying).forceApprove(vaultAsset, vaultUnderlyingNeeded);
        uint256 actualVaultUnderlyingSpent = vault.mint(sharesAmount, address(this));
        IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);

        // Sanity check: vault should not consume more than previewed
        if (actualVaultUnderlyingSpent > vaultUnderlyingNeeded) {
            revert ErrorsLib.SlippageExceeded(vaultUnderlying, actualVaultUnderlyingSpent, vaultUnderlyingNeeded);
        }

        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);
    }
}
