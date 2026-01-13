// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IExecutionAdapter, IExecutionAdapterWithRouting } from "../interfaces/IExecutionAdapter.sol";
import { ISwapExecutor } from "../interfaces/ISwapExecutor.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ILiquidityOrchestrator } from "../interfaces/ILiquidityOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
/**
 * @title ERC4626ExecutionAdapter
 * @notice Execution adapter for ERC4626 vaults supporting both same-asset and cross-asset flows
 * @author Orion Finance
 * @dev Handles:
 *   - Same-asset: USDC → identity swap → USDC vault deposit (passthrough)
 *   - Cross-asset: USDC → DEX swap → underlying → vault deposit
 *
 * Architecture:
 * - Buy:  LO (USDC) → SwapExecutor (USDC→underlying) → Vault (underlying→shares) → LO (shares)
 * - Sell: LO (shares) → Vault (shares→underlying) → SwapExecutor (underlying→USDC) → LO (USDC)
 *
 * Security invariants:
 * 1. Single slippage envelope covers both swap and vault operations
 * 2. Exact-output swaps for buy (guarantee exact vault deposit amount)
 * 3. Exact-input swaps for sell (convert all underlying received)
 * 4. All approvals are transient and zeroed immediately after use
 * 5. Adapter never holds funds between transactions
 *
 * Note on dust accumulation:
 * The adapter may accumulate negligible dust amounts in vault underlying due to vault rounding.
 * This is acceptable per the architecture design and does not affect security or user funds.
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626ExecutionAdapter is IExecutionAdapterWithRouting {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Basis points factor for slippage calculations
    uint256 public constant BASIS_POINTS_FACTOR = 10_000;

    /// @notice Orion protocol configuration contract
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    IOrionConfig public immutable config;
    /// @notice Protocol underlying asset (USDC)
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    IERC20 public immutable underlyingAsset;
    /// @notice Liquidity orchestrator contract
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    ILiquidityOrchestrator public immutable liquidityOrchestrator;
    /// @notice Swap executor for DEX operations
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    ISwapExecutor public immutable swapExecutor;

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) {
            revert ErrorsLib.UnauthorizedCaller();
        }
        _;
    }

    /**
     * @notice Calculate maximum amount with slippage applied
     * @param estimatedAmount The estimated amount
     * @return maxAmount Maximum amount including slippage tolerance
     * @dev TODO: Move slippage calculation to LiquidityOrchestrator
     */
    function _calculateMaxWithSlippage(uint256 estimatedAmount) internal view returns (uint256 maxAmount) {
        return
            estimatedAmount.mulDiv(
                BASIS_POINTS_FACTOR + liquidityOrchestrator.slippageTolerance(),
                BASIS_POINTS_FACTOR
            );
    }

    /**
     * @notice Calculate minimum amount with slippage applied
     * @param estimatedAmount The estimated amount
     * @return minAmount Minimum amount including slippage tolerance
     * @dev TODO: Move slippage calculation to LiquidityOrchestrator
     */
    function _calculateMinWithSlippage(uint256 estimatedAmount) internal view returns (uint256 minAmount) {
        return
            estimatedAmount.mulDiv(
                BASIS_POINTS_FACTOR - liquidityOrchestrator.slippageTolerance(),
                BASIS_POINTS_FACTOR
            );
    }

    /**
     * @notice Constructor
     * @param configAddress OrionConfig contract address
     * @param swapExecutorAddress SwapExecutor implementation address
     */
    constructor(address configAddress, address swapExecutorAddress) {
        if (configAddress == address(0) || swapExecutorAddress == address(0)) {
            revert ErrorsLib.ZeroAddress();
        }

        config = IOrionConfig(configAddress);
        underlyingAsset = config.underlyingAsset(); // USDC
        liquidityOrchestrator = ILiquidityOrchestrator(config.liquidityOrchestrator());
        swapExecutor = ISwapExecutor(swapExecutorAddress);
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        IERC4626 vault = IERC4626(asset);

        // Verify asset implements ERC4626 and get underlying
        address vaultUnderlying;
        try vault.asset() returns (address underlying) {
            vaultUnderlying = underlying;
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // Verify vault decimals match config
        try IERC20Metadata(asset).decimals() returns (uint8 vaultDecimals) {
            if (vaultDecimals != config.getTokenDecimals(asset)) {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // Verify vault underlying decimals are registered
        try IERC20Metadata(vaultUnderlying).decimals() returns (uint8 underlyingDecimals) {
            uint8 configDecimals = config.getTokenDecimals(vaultUnderlying);
            if (configDecimals == 0 || underlyingDecimals != configDecimals) {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount
    ) external onlyLiquidityOrchestrator returns (uint256 executionUnderlyingAmount) {
        // Call routing version with empty params
        return _buyWithRouting(vaultAsset, sharesAmount, estimatedUnderlyingAmount, "");
    }

    /// @inheritdoc IExecutionAdapterWithRouting
    // solhint-disable-next-line function-max-lines, use-natspec
    function buy(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount,
        bytes calldata routeParams
    ) external onlyLiquidityOrchestrator returns (uint256 executionUnderlyingAmount) {
        return _buyWithRouting(vaultAsset, sharesAmount, estimatedUnderlyingAmount, routeParams);
    }

    /// @dev Internal implementation of buy with routing
    // solhint-disable-next-line function-max-lines, use-natspec
    function _buyWithRouting(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount,
        bytes memory routeParams
    ) internal returns (uint256 executionUnderlyingAmount) {
        // Atomically validate all assumptions
        this.validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        // Step 1: Calculate underlying needed for exact shares
        // previewMint returns underlying needed to mint exact sharesAmount
        uint256 underlyingNeeded = vault.previewMint(sharesAmount);

        // Step 2: Calculate max underlying with slippage envelope
        // This single envelope covers BOTH swap and vault operations
        uint256 maxUnderlying = _calculateMaxWithSlippage(estimatedUnderlyingAmount);

        uint256 underlyingSpentOnSwap = 0;

        // Step 3-6: Handle same-asset vs cross-asset scenarios
        if (vaultUnderlying == address(underlyingAsset)) {
            // Same-asset: vault's underlying IS the protocol underlying (e.g., USDC vault)
            // No swap needed - pull exact amount needed by vault
            // Note: We pull underlyingNeeded which vault.previewMint() calculated
            // The LO approved maxUnderlying, so this will revert if underlyingNeeded > maxUnderlying
            underlyingAsset.safeTransferFrom(msg.sender, address(this), underlyingNeeded);
            underlyingSpentOnSwap = underlyingNeeded;
        } else {
            // Cross-asset: vault's underlying is different (e.g., WETH, WBTC)
            // Need to swap underlying → vault asset

            // Pull max underlying from LO to cover swap slippage
            underlyingAsset.safeTransferFrom(msg.sender, address(this), maxUnderlying);

            // Step 4: Approve swap executor to spend underlying
            underlyingAsset.forceApprove(address(swapExecutor), maxUnderlying);

            // Step 5: Execute exact-output swap (USDC → vault underlying)
            // SwapExecutor guarantees exact underlyingNeeded output or reverts
            underlyingSpentOnSwap = swapExecutor.swapExactOutput(
                address(underlyingAsset),
                vaultUnderlying,
                underlyingNeeded,
                maxUnderlying,
                routeParams
            );

            // Step 6: Clean up swap executor approval
            underlyingAsset.forceApprove(address(swapExecutor), 0);
        }

        // Step 7: Approve vault to spend underlying
        IERC20(vaultUnderlying).forceApprove(vaultAsset, underlyingNeeded);

        // Step 8: Mint exact shares
        // Vault pulls underlyingNeeded, mints sharesAmount to adapter
        vault.mint(sharesAmount, address(this));

        // Step 9: Clean up vault approval
        IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);

        // Step 10: Refund excess underlying to LO (if swap used less than max)
        uint256 underlyingBalance = underlyingAsset.balanceOf(address(this));
        if (underlyingBalance > 0) {
            underlyingAsset.safeTransfer(msg.sender, underlyingBalance);
        }

        // Step 11: Push exact shares to LO
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);

        // Step 12: Return actual underlying spent
        // LO will enforce slippage by comparing executionUnderlyingAmount vs estimatedUnderlyingAmount
        executionUnderlyingAmount = underlyingSpentOnSwap;
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount
    ) external onlyLiquidityOrchestrator returns (uint256 executionUnderlyingAmount) {
        // Call routing version with empty params
        return _sellWithRouting(vaultAsset, sharesAmount, estimatedUnderlyingAmount, "");
    }

    /// @inheritdoc IExecutionAdapterWithRouting
    // solhint-disable-next-line function-max-lines, use-natspec
    function sell(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount,
        bytes calldata routeParams
    ) external onlyLiquidityOrchestrator returns (uint256 executionUnderlyingAmount) {
        return _sellWithRouting(vaultAsset, sharesAmount, estimatedUnderlyingAmount, routeParams);
    }

    /// @dev Internal implementation of sell with routing
    // solhint-disable-next-line function-max-lines, use-natspec
    function _sellWithRouting(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount,
        bytes memory routeParams
    ) internal returns (uint256 executionUnderlyingAmount) {
        // Atomically validate all assumptions
        this.validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        // Step 1: Redeem vault shares for underlying
        // Vault burns sharesAmount from LO, sends underlying to adapter
        uint256 underlyingReceived = vault.redeem(
            sharesAmount,
            address(this), // receiver: adapter holds underlying temporarily
            msg.sender // owner: LO owns the shares
        );

        // Step 2: Calculate min underlying with slippage envelope
        uint256 minUnderlying = _calculateMinWithSlippage(estimatedUnderlyingAmount);

        uint256 protocolUnderlyingReceived = 0;

        // Step 3-5: Handle same-asset vs cross-asset scenarios
        if (vaultUnderlying == address(underlyingAsset)) {
            // Same-asset: vault's underlying IS the protocol underlying (e.g., USDC vault)
            // No swap needed - underlying received IS protocol underlying
            protocolUnderlyingReceived = underlyingReceived;
        } else {
            // Cross-asset: vault's underlying is different (e.g., WETH, WBTC)
            // Need to swap vault underlying → protocol underlying

            // Step 3: Approve swap executor to spend vault underlying
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), underlyingReceived);

            // Step 4: Execute exact-input swap (vault underlying → USDC)
            // We swap ALL underlying received from vault redeem
            protocolUnderlyingReceived = swapExecutor.swapExactInput(
                vaultUnderlying,
                address(underlyingAsset),
                underlyingReceived,
                minUnderlying,
                routeParams
            );

            // Step 5: Clean up swap executor approval
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), 0);
        }

        // Step 6: Push all protocol underlying to LO
        underlyingAsset.safeTransfer(msg.sender, protocolUnderlyingReceived);

        // LO will enforce slippage by comparing executionUnderlyingAmount vs estimatedUnderlyingAmount
        executionUnderlyingAmount = protocolUnderlyingReceived;
    }
}
