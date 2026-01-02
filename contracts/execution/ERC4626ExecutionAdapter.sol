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
 * 5. Adapter never holds funds between transactions (dust acceptable)
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626ExecutionAdapter is IExecutionAdapterWithRouting {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Basis points factor for slippage calculations
    uint256 public constant BASIS_POINTS_FACTOR = 10000;

    /// @notice Orion protocol configuration contract
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    IOrionConfig public immutable config;
    /// @notice Protocol numeraire token (USDC)
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    IERC20 public immutable numeraireToken;
    /// @notice Liquidity orchestrator contract
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    ILiquidityOrchestrator public immutable liquidityOrchestrator;
    /// @notice Swap executor for DEX operations
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    ISwapExecutor public immutable swapExecutor;

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
        numeraireToken = config.underlyingAsset(); // USDC
        liquidityOrchestrator = ILiquidityOrchestrator(config.liquidityOrchestrator());
        swapExecutor = ISwapExecutor(swapExecutorAddress);
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        // Verify asset implements ERC4626
        try IERC4626(asset).asset() returns (address) {
            // Asset implements ERC4626 - additional validation
        } catch {
            // Asset does not implement ERC4626
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // Verify vault decimals match config
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != config.getTokenDecimals(asset)) {
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
        uint256 estimatedNumeraireAmount
    ) external onlyLiquidityOrchestrator returns (uint256 spentNumeraireAmount) {
        // Call routing version with empty params
        return _buyWithRouting(vaultAsset, sharesAmount, estimatedNumeraireAmount, "");
    }

    /// @inheritdoc IExecutionAdapterWithRouting
    // solhint-disable-next-line function-max-lines, use-natspec
    function buy(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedNumeraireAmount,
        bytes calldata routeParams
    ) external onlyLiquidityOrchestrator returns (uint256 spentNumeraireAmount) {
        return _buyWithRouting(vaultAsset, sharesAmount, estimatedNumeraireAmount, routeParams);
    }

    /// @dev Internal implementation of buy with routing
    // solhint-disable-next-line function-max-lines, use-natspec
    function _buyWithRouting(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedNumeraireAmount,
        bytes memory routeParams
    ) internal returns (uint256 spentNumeraireAmount) {
        // Atomically validate all assumptions
        this.validateExecutionAdapter(vaultAsset);

        IERC4626 vault = IERC4626(vaultAsset);
        address vaultUnderlying = vault.asset();

        // Step 1: Calculate underlying needed for exact shares
        // previewMint returns underlying needed to mint exact sharesAmount
        uint256 underlyingNeeded = vault.previewMint(sharesAmount);

        // Step 2: Calculate max numeraire with slippage envelope
        // This single envelope covers BOTH swap and vault operations
        uint256 maxNumeraire = estimatedNumeraireAmount.mulDiv(
            BASIS_POINTS_FACTOR + liquidityOrchestrator.slippageTolerance(),
            BASIS_POINTS_FACTOR
        );

        uint256 numeraireSpentOnSwap = 0;

        // Step 3-6: Handle same-asset vs cross-asset scenarios
        if (vaultUnderlying == address(numeraireToken)) {
            // Same-asset: vault's underlying IS the numeraire (e.g., USDC vault)
            // No swap needed - pull exact amount needed by vault
            // Note: We pull underlyingNeeded which vault.previewMint() calculated
            // The LO approved maxNumeraire, so this will revert if underlyingNeeded > maxNumeraire
            numeraireToken.safeTransferFrom(msg.sender, address(this), underlyingNeeded);
            numeraireSpentOnSwap = underlyingNeeded;
        } else {
            // Cross-asset: vault's underlying is different (e.g., WETH, WBTC)
            // Need to swap numeraire → underlying

            // Pull max numeraire from LO to cover swap slippage
            numeraireToken.safeTransferFrom(msg.sender, address(this), maxNumeraire);

            // Step 4: Approve swap executor to spend numeraire
            numeraireToken.forceApprove(address(swapExecutor), maxNumeraire);

            // Step 5: Execute exact-output swap (USDC → underlying)
            // SwapExecutor guarantees exact underlyingNeeded output or reverts
            try
                swapExecutor.swapExactOutput(
                    address(numeraireToken), // tokenIn: USDC
                    vaultUnderlying, // tokenOut: WETH/WBTC/etc
                    underlyingNeeded, // amountOut: exact amount needed
                    maxNumeraire, // amountInMax: slippage limit
                    routeParams // venue-specific routing
                )
            returns (uint256 actualNumeraireSpent) {
                numeraireSpentOnSwap = actualNumeraireSpent;
            } catch {
                // Clean up before revert
                numeraireToken.forceApprove(address(swapExecutor), 0);
                revert ErrorsLib.SwapFailed();
            }

            // Step 6: Clean up swap executor approval
            numeraireToken.forceApprove(address(swapExecutor), 0);
        }

        // Step 7: Approve vault to spend underlying
        IERC20(vaultUnderlying).forceApprove(vaultAsset, underlyingNeeded);

        // Step 8: Mint exact shares
        // Vault pulls underlyingNeeded, mints sharesAmount to adapter
        vault.mint(sharesAmount, address(this));

        // Step 9: Clean up vault approval
        IERC20(vaultUnderlying).forceApprove(vaultAsset, 0);

        // Step 10: Refund excess numeraire to LO (if swap used less than max)
        uint256 numeraireBalance = numeraireToken.balanceOf(address(this));
        if (numeraireBalance > 0) {
            numeraireToken.safeTransfer(msg.sender, numeraireBalance);
        }

        // Step 11: Push exact shares to LO
        IERC20(vaultAsset).safeTransfer(msg.sender, sharesAmount);

        // Step 12: Return actual numeraire spent
        // LO will enforce slippage by comparing spentNumeraireAmount vs estimatedNumeraireAmount
        spentNumeraireAmount = numeraireSpentOnSwap;

        // Note: Adapter may accumulate dust in vaultUnderlying if vault rounding leaves residual
        // This is acceptable per the architecture - dust amounts are negligible
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedNumeraireAmount
    ) external onlyLiquidityOrchestrator returns (uint256 receivedNumeraireAmount) {
        // Call routing version with empty params
        return _sellWithRouting(vaultAsset, sharesAmount, estimatedNumeraireAmount, "");
    }

    /// @inheritdoc IExecutionAdapterWithRouting
    // solhint-disable-next-line function-max-lines, use-natspec
    function sell(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedNumeraireAmount,
        bytes calldata routeParams
    ) external onlyLiquidityOrchestrator returns (uint256 receivedNumeraireAmount) {
        return _sellWithRouting(vaultAsset, sharesAmount, estimatedNumeraireAmount, routeParams);
    }

    /// @dev Internal implementation of sell with routing
    // solhint-disable-next-line function-max-lines, use-natspec
    function _sellWithRouting(
        address vaultAsset,
        uint256 sharesAmount,
        uint256 estimatedNumeraireAmount,
        bytes memory routeParams
    ) internal returns (uint256 receivedNumeraireAmount) {
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

        // Step 2: Calculate min numeraire with slippage envelope
        uint256 minNumeraire = estimatedNumeraireAmount.mulDiv(
            BASIS_POINTS_FACTOR - liquidityOrchestrator.slippageTolerance(),
            BASIS_POINTS_FACTOR
        );

        uint256 numeraireReceived = 0;

        // Step 3-5: Handle same-asset vs cross-asset scenarios
        if (vaultUnderlying == address(numeraireToken)) {
            // Same-asset: vault's underlying IS the numeraire (e.g., USDC vault)
            // No swap needed - underlying received IS numeraire
            numeraireReceived = underlyingReceived;
        } else {
            // Cross-asset: vault's underlying is different (e.g., WETH, WBTC)
            // Need to swap underlying → numeraire

            // Step 3: Approve swap executor to spend underlying
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), underlyingReceived);

            // Step 4: Execute exact-input swap (underlying → USDC)
            // We swap ALL underlying received from vault redeem
            try
                swapExecutor.swapExactInput(
                    vaultUnderlying, // tokenIn: WETH/WBTC/etc
                    address(numeraireToken), // tokenOut: USDC
                    underlyingReceived, // amountIn: all underlying from vault
                    minNumeraire, // amountOutMin: slippage protection
                    routeParams // venue-specific routing
                )
            returns (uint256 actualNumeraireReceived) {
                numeraireReceived = actualNumeraireReceived;
            } catch {
                // Clean up before revert
                IERC20(vaultUnderlying).forceApprove(address(swapExecutor), 0);
                revert ErrorsLib.SwapFailed();
            }

            // Step 5: Clean up swap executor approval
            IERC20(vaultUnderlying).forceApprove(address(swapExecutor), 0);
        }

        // Step 6: Push all numeraire to LO
        numeraireToken.safeTransfer(msg.sender, numeraireReceived);

        // LO will enforce slippage by comparing receivedNumeraireAmount vs estimatedNumeraireAmount
        receivedNumeraireAmount = numeraireReceived;
    }

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(liquidityOrchestrator)) {
            revert ErrorsLib.UnauthorizedCaller();
        }
        _;
    }
}
