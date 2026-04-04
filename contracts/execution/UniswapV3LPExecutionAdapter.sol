// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { UniswapV3LiquidityAmounts as LiquidityAmounts } from "../libraries/UniswapV3LiquidityAmounts.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IUniswapV3LPWrapper } from "../interfaces/IUniswapV3LPWrapper.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ILiquidityOrchestrator } from "../interfaces/ILiquidityOrchestrator.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

/**
 * @title UniswapV3LPExecutionAdapter
 * @notice Execution adapter that buys and sells Uniswap V3 LP positions wrapped as ERC20 shares.
 * @author Orion Finance
 *
 * @dev Architecture
 * ─────────────────
 * This adapter bridges the Orion `IExecutionAdapter` interface with Uniswap V3 liquidity positions.
 * Each "asset" in the Orion protocol is a `UniswapV3LPWrapper` (an ERC20 wrapping one NFT position).
 *
 * Buy flow (underlying → LP shares):
 *   1. Compute the liquidity units that correspond to the requested share count.
 *   2. Compute (amount0, amount1) for that liquidity at the current pool price.
 *   3. Acquire each token by calling the registered per-token swap adapter (or using underlying directly
 *      when the token equals the protocol underlying).
 *   4. Call wrapper.depositLiquidity(..., minSharesOut = shares) so minted shares match the LO order.
 *   5. Swap back any unused token0/token1 (returned by the wrapper) to underlying.
 *   6. Transfer minted shares to LO and return actual underlying spent.
 *
 * Sell flow (LP shares → underlying):
 *   1. Pull shares from LO (LO pre-approves adapter).
 *   2. Call wrapper.withdrawLiquidity(shares, address(this)) to get (amount0, amount1).
 *   3. Swap each token to underlying via the registered per-token swap adapter.
 *   4. Transfer total underlying to LO and return amount received.
 *
 * Token swap adapters
 * ────────────────────
 * For each pool token the owner registers a per-token `IExecutionAdapter` that handles
 * swaps between that token and the protocol underlying.
 * If a pool token IS the protocol underlying, set its swap adapter to address(0).
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract UniswapV3LPExecutionAdapter is IExecutionAdapter, Ownable2Step {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Structs ──────────────────────────────────────────────────────────────

    /// @notice Per-wrapper configuration
    struct WrapperConfig {
        /// @notice The LP wrapper registered for this asset address (non-zero = configured)
        IUniswapV3LPWrapper wrapper;
        /// @notice Swap adapter for TOKEN0 (address(0) when TOKEN0 == underlying)
        IExecutionAdapter token0SwapAdapter;
        /// @notice Swap adapter for TOKEN1 (address(0) when TOKEN1 == underlying)
        IExecutionAdapter token1SwapAdapter;
    }

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @notice Orion Config contract
    IOrionConfig public immutable CONFIG;

    /// @notice Protocol underlying asset address
    address public immutable UNDERLYING_ASSET;

    /// @notice Liquidity orchestrator
    ILiquidityOrchestrator public immutable LIQUIDITY_ORCHESTRATOR;

    /// @notice Uniswap V3 Factory (used in validateExecutionAdapter)
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;

    // ─── Mutable state ────────────────────────────────────────────────────────

    /// @notice asset (wrapper address) → configuration
    mapping(address => WrapperConfig) public wrapperConfigOf;

    // ─── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyLiquidityOrchestrator() {
        if (msg.sender != address(LIQUIDITY_ORCHESTRATOR)) revert ErrorsLib.NotAuthorized();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != CONFIG.guardian()) revert ErrorsLib.NotAuthorized();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @notice Deploys the adapter with owner, Orion config, and Uniswap V3 factory.
     * @param initialOwner_    Contract owner / admin
     * @param configAddress    OrionConfig contract address
     * @param factoryAddress   Uniswap V3 Factory address
     */
    constructor(address initialOwner_, address configAddress, address factoryAddress) Ownable(initialOwner_) {
        if (initialOwner_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (factoryAddress == address(0)) revert ErrorsLib.ZeroAddress();

        CONFIG = IOrionConfig(configAddress);
        UNDERLYING_ASSET = address(CONFIG.underlyingAsset());
        LIQUIDITY_ORCHESTRATOR = ILiquidityOrchestrator(CONFIG.liquidityOrchestrator());
        UNISWAP_V3_FACTORY = IUniswapV3Factory(factoryAddress);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /**
     * @notice Register a UniswapV3LPWrapper as a supported asset.
     * @dev Wiring sequence for each new LP position:
     *      1. Both TOKEN0 and TOKEN1 must already be whitelisted in OrionConfig (i.e. priced).
     *      2. Deploy UniswapV3LPWrapper with this adapter as the `executionAdapter_` constructor param.
     *      3. Deploy UniswapV3LPPriceAdapter(configAddress, factoryAddress).
     *      4. Call this function (setWrapperConfig) as owner/guardian.
     *      5. Call OrionConfig.addWhitelistedAsset(wrapper, priceAdapter, thisExecutionAdapter).
     *
     *      For each pool token that IS the protocol underlying, set its swap adapter to address(0).
     *      This function validates that the pool exists and the tick range is set in the wrapper.
     * @param wrapperAddress      The ERC20 LP wrapper (= the "asset" in Orion)
     * @param token0SwapAdapter_  IExecutionAdapter for TOKEN0 ↔ underlying swaps (address(0) if TOKEN0 == underlying)
     * @param token1SwapAdapter_  IExecutionAdapter for TOKEN1 ↔ underlying swaps (address(0) if TOKEN1 == underlying)
     */
    function setWrapperConfig(
        address wrapperAddress,
        address token0SwapAdapter_,
        address token1SwapAdapter_
    ) external onlyOwnerOrGuardian {
        if (wrapperAddress == address(0)) revert ErrorsLib.ZeroAddress();

        IUniswapV3LPWrapper wrapper = IUniswapV3LPWrapper(wrapperAddress);

        // Pool must exist
        address pool = UNISWAP_V3_FACTORY.getPool(wrapper.TOKEN0(), wrapper.TOKEN1(), wrapper.FEE());
        if (pool == address(0)) revert ErrorsLib.InvalidAdapter(wrapperAddress);
        if (pool != wrapper.POOL()) revert ErrorsLib.InvalidAdapter(wrapperAddress);

        // Validate swap adapters are consistent with the token layout
        if (wrapper.TOKEN0() == UNDERLYING_ASSET && token0SwapAdapter_ != address(0))
            revert ErrorsLib.InvalidAdapter(wrapperAddress);
        if (wrapper.TOKEN0() != UNDERLYING_ASSET && token0SwapAdapter_ == address(0))
            revert ErrorsLib.InvalidAdapter(wrapperAddress);
        if (wrapper.TOKEN1() == UNDERLYING_ASSET && token1SwapAdapter_ != address(0))
            revert ErrorsLib.InvalidAdapter(wrapperAddress);
        if (wrapper.TOKEN1() != UNDERLYING_ASSET && token1SwapAdapter_ == address(0))
            revert ErrorsLib.InvalidAdapter(wrapperAddress);

        wrapperConfigOf[wrapperAddress] = WrapperConfig({
            wrapper: wrapper,
            token0SwapAdapter: IExecutionAdapter(token0SwapAdapter_),
            token1SwapAdapter: IExecutionAdapter(token1SwapAdapter_)
        });
    }

    // ─── IExecutionAdapter ────────────────────────────────────────────────────

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        WrapperConfig memory cfg = wrapperConfigOf[asset];
        if (address(cfg.wrapper) == address(0)) revert ErrorsLib.InvalidAdapter(asset);

        // Pool must still exist and match the wrapper (guard against misconfiguration)
        IUniswapV3LPWrapper wrapper = cfg.wrapper;
        address pool = UNISWAP_V3_FACTORY.getPool(wrapper.TOKEN0(), wrapper.TOKEN1(), wrapper.FEE());
        if (pool == address(0)) revert ErrorsLib.InvalidAdapter(asset);
        if (pool != wrapper.POOL()) revert ErrorsLib.InvalidAdapter(asset);

        // sqrtRatios must be sane
        if (wrapper.SQRT_RATIO_LOWER_X96() == 0 || wrapper.SQRT_RATIO_UPPER_X96() == 0)
            revert ErrorsLib.InvalidAdapter(asset);
    }

    /// @inheritdoc IExecutionAdapter
    function previewBuy(address asset, uint256 shares) external override returns (uint256 underlyingAmount) {
        WrapperConfig memory cfg = _getValidatedConfig(asset);
        IUniswapV3LPWrapper wrapper = cfg.wrapper;

        if (shares == 0) return 0;

        uint128 liquidityNeeded = _sharesToLiquidity(wrapper, shares);
        (uint256 amount0, uint256 amount1) = _liquidityToAmounts(wrapper, liquidityNeeded);

        underlyingAmount =
            _previewAcquireToken(wrapper.TOKEN0(), amount0, cfg.token0SwapAdapter) +
            _previewAcquireToken(wrapper.TOKEN1(), amount1, cfg.token1SwapAdapter);
    }

    /// @inheritdoc IExecutionAdapter
    function buy(
        address asset,
        uint256 shares
    ) external override onlyLiquidityOrchestrator returns (uint256 spentUnderlyingAmount) {
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset);

        WrapperConfig memory cfg = _getValidatedConfig(asset);
        IUniswapV3LPWrapper wrapper = cfg.wrapper;

        // Compute target liquidity and desired token amounts at current price
        uint128 liquidityNeeded = _sharesToLiquidity(wrapper, shares);
        (uint256 amount0Desired, uint256 amount1Desired) = _liquidityToAmounts(wrapper, liquidityNeeded);

        // Preview total underlying needed
        uint256 underlying0 = _previewAcquireToken(wrapper.TOKEN0(), amount0Desired, cfg.token0SwapAdapter);
        uint256 underlying1 = _previewAcquireToken(wrapper.TOKEN1(), amount1Desired, cfg.token1SwapAdapter);
        uint256 underlyingNeeded = underlying0 + underlying1;

        // Pull from LO (LO has already approved this adapter up to maxWithSlippage)
        IERC20(UNDERLYING_ASSET).safeTransferFrom(msg.sender, address(this), underlyingNeeded);

        // Acquire token0 and token1 (spending underlying)
        uint256 actualUnderlying0 = _acquireToken(wrapper.TOKEN0(), amount0Desired, cfg.token0SwapAdapter, underlying0);
        uint256 actualUnderlying1 = _acquireToken(wrapper.TOKEN1(), amount1Desired, cfg.token1SwapAdapter, underlying1);

        // Approve wrapper and deposit liquidity
        IERC20(wrapper.TOKEN0()).forceApprove(asset, amount0Desired);
        IERC20(wrapper.TOKEN1()).forceApprove(asset, amount1Desired);

        (uint256 sharesMinted, uint256 used0, uint256 used1) = wrapper.depositLiquidity(
            amount0Desired,
            amount1Desired,
            address(this),
            shares
        );

        // Clean up approvals (depositLiquidity may have cleared them, but be safe)
        IERC20(wrapper.TOKEN0()).forceApprove(asset, 0);
        IERC20(wrapper.TOKEN1()).forceApprove(asset, 0);

        // LO receives `sharesMinted` (wrapper enforces sharesMinted >= `shares` via minSharesOut).

        // Swap back unused tokens to underlying and account for refunds
        uint256 unused0 = amount0Desired - used0;
        uint256 unused1 = amount1Desired - used1;
        uint256 refund0 = _sellToken(wrapper.TOKEN0(), unused0, cfg.token0SwapAdapter);
        uint256 refund1 = _sellToken(wrapper.TOKEN1(), unused1, cfg.token1SwapAdapter);

        // Return refunded underlying to LO
        uint256 totalRefund = refund0 + refund1;
        if (totalRefund > 0) IERC20(UNDERLYING_ASSET).safeTransfer(msg.sender, totalRefund);

        // Transfer LP shares to LO
        IERC20(asset).safeTransfer(msg.sender, sharesMinted);

        spentUnderlyingAmount = actualUnderlying0 + actualUnderlying1 - totalRefund;
    }

    /// @inheritdoc IExecutionAdapter
    function sell(
        address asset,
        uint256 shares
    ) external override onlyLiquidityOrchestrator returns (uint256 receivedUnderlyingAmount) {
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(asset);

        WrapperConfig memory cfg = _getValidatedConfig(asset);
        IUniswapV3LPWrapper wrapper = cfg.wrapper;

        // Pull shares from LO (LO approved this adapter)
        IERC20(asset).safeTransferFrom(msg.sender, address(this), shares);

        // Withdraw liquidity + fees from the wrapper
        (uint256 amount0, uint256 amount1) = wrapper.withdrawLiquidity(shares, address(this));

        // Swap each token back to underlying
        uint256 underlying0 = _sellToken(wrapper.TOKEN0(), amount0, cfg.token0SwapAdapter);
        uint256 underlying1 = _sellToken(wrapper.TOKEN1(), amount1, cfg.token1SwapAdapter);

        receivedUnderlyingAmount = underlying0 + underlying1;

        // Transfer underlying to LO
        if (receivedUnderlyingAmount > 0) {
            IERC20(UNDERLYING_ASSET).safeTransfer(msg.sender, receivedUnderlyingAmount);
        }
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _getValidatedConfig(address asset) internal view returns (WrapperConfig memory cfg) {
        cfg = wrapperConfigOf[asset];
        if (address(cfg.wrapper) == address(0)) revert ErrorsLib.InvalidAdapter(asset);
    }

    /**
     * @dev Convert wrapper share count to Uniswap V3 liquidity units.
     *      • Empty wrapper (no supply yet): shares are treated 1:1 with liquidity units.
     *      • Non-empty wrapper: proportional to current totalLiquidity / totalSupply.
     *      Must stay aligned with {UniswapV3LPWrapper.depositLiquidity} share minting logic.
     */
    function _sharesToLiquidity(IUniswapV3LPWrapper wrapper, uint256 shares) internal view returns (uint128 liquidity) {
        uint256 supply = wrapper.totalSupply();
        uint128 totalLiq = wrapper.totalLiquidity();

        if (supply == 0 || totalLiq == 0) {
            // First deposit: 1 share = 1 liquidity unit
            if (shares > type(uint128).max) revert ErrorsLib.InvalidArguments();
            return uint128(shares);
        }

        uint256 liqU256 = uint256(totalLiq).mulDiv(shares, supply);
        if (liqU256 == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(wrapper));
        if (liqU256 > type(uint128).max) revert ErrorsLib.InvalidArguments();
        return uint128(liqU256);
    }

    /**
     * @dev Compute (amount0, amount1) needed to add `liquidity` to the wrapper's position
     *      at the current pool price.
     */
    function _liquidityToAmounts(
        IUniswapV3LPWrapper wrapper,
        uint128 liquidity
    ) internal view returns (uint256 amount0, uint256 amount1) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(wrapper.POOL()).slot0();
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            wrapper.SQRT_RATIO_LOWER_X96(),
            wrapper.SQRT_RATIO_UPPER_X96(),
            liquidity
        );
    }

    /**
     * @dev Preview underlying required to acquire `amount` of `token`.
     *      Returns `amount` directly when token IS the protocol underlying.
     */
    function _previewAcquireToken(
        address token,
        uint256 amount,
        IExecutionAdapter swapAdapter
    ) internal returns (uint256) {
        if (amount == 0) return 0;
        if (token == UNDERLYING_ASSET) return amount;
        return swapAdapter.previewBuy(token, amount);
    }

    /**
     * @dev Acquire exactly `tokenAmount` of `token` by spending underlying.
     *      When token == UNDERLYING_ASSET nothing needs to be done (underlying is already held).
     *      Returns the actual underlying amount consumed.
     */
    function _acquireToken(
        address token,
        uint256 tokenAmount,
        IExecutionAdapter swapAdapter,
        uint256 underlyingBudget
    ) internal returns (uint256 underlyingSpent) {
        if (tokenAmount == 0) return 0;
        if (token == UNDERLYING_ASSET) return tokenAmount;

        // Approve swap adapter and call buy (exactOutput swap)
        IERC20(UNDERLYING_ASSET).forceApprove(address(swapAdapter), underlyingBudget);
        underlyingSpent = swapAdapter.buy(token, tokenAmount);
        IERC20(UNDERLYING_ASSET).forceApprove(address(swapAdapter), 0);
    }

    /**
     * @dev Sell `tokenAmount` of `token` for underlying.
     *      When token == UNDERLYING_ASSET: no swap, underlying already held, return tokenAmount.
     *      Returns the actual underlying amount received.
     */
    function _sellToken(
        address token,
        uint256 tokenAmount,
        IExecutionAdapter swapAdapter
    ) internal returns (uint256 underlyingReceived) {
        if (tokenAmount == 0) return 0;
        if (token == UNDERLYING_ASSET) return tokenAmount;

        // Approve swap adapter and sell (exactInput swap)
        IERC20(token).forceApprove(address(swapAdapter), tokenAmount);
        underlyingReceived = swapAdapter.sell(token, tokenAmount);
        IERC20(token).forceApprove(address(swapAdapter), 0);
    }
}
