// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IUniswapV3NonfungiblePositionManager } from "../interfaces/IUniswapV3NonfungiblePositionManager.sol";
import { IUniswapV3LPWrapper } from "../interfaces/IUniswapV3LPWrapper.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

/**
 * @title UniswapV3LPWrapper
 * @notice ERC20 wrapper for a single Uniswap V3 NFT position at a fixed (token0, token1, fee, tickLower, tickUpper).
 * @author Orion Finance
 *
 * @dev Architecture
 * ─────────────────
 * One wrapper = one NFT position. Shares are proportional to liquidity:
 *   • First deposit:  shares = liquidityMinted   (1 share per unit of liquidity)
 *   • Subsequent:     shares = mulDiv(liquidityMinted, totalSupply_before, totalLiquidity_before)
 *   • Withdrawal:     liquidity = mulDiv(shares, totalLiquidity, totalSupply)
 *
 * Access control
 * ──────────────
 * Only the registered execution adapter may call depositLiquidity / withdrawLiquidity.
 *
 * sqrtRatioLowerX96 / sqrtRatioUpperX96
 * ──────────────────────────────────────
 * TickMath (GPL ≤0.7) cannot be imported into 0.8.28 contracts.
 * Callers compute TickMath.getSqrtRatioAtTick(tickLower/Upper) off-chain (or in a deploy script)
 * and pass the results to the constructor.
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract UniswapV3LPWrapper is IUniswapV3LPWrapper, ERC20, Ownable2Step {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @notice Uniswap V3 NonfungiblePositionManager
    IUniswapV3NonfungiblePositionManager public immutable POSITION_MANAGER;

    /// @inheritdoc IUniswapV3LPWrapper
    address public immutable override POOL;

    /// @inheritdoc IUniswapV3LPWrapper
    address public immutable override TOKEN0;

    /// @inheritdoc IUniswapV3LPWrapper
    address public immutable override TOKEN1;

    /// @inheritdoc IUniswapV3LPWrapper
    uint24 public immutable override FEE;

    /// @inheritdoc IUniswapV3LPWrapper
    int24 public immutable override TICK_LOWER;

    /// @inheritdoc IUniswapV3LPWrapper
    int24 public immutable override TICK_UPPER;

    /// @inheritdoc IUniswapV3LPWrapper
    uint160 public immutable override SQRT_RATIO_LOWER_X96;

    /// @inheritdoc IUniswapV3LPWrapper
    uint160 public immutable override SQRT_RATIO_UPPER_X96;

    /// @notice Only this address may call depositLiquidity / withdrawLiquidity
    address public immutable EXECUTION_ADAPTER;

    // ─── Mutable state ────────────────────────────────────────────────────────

    /// @inheritdoc IUniswapV3LPWrapper
    uint256 public override tokenId;

    // ─── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyAdapter() {
        if (msg.sender != EXECUTION_ADAPTER) revert ErrorsLib.NotAuthorized();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @notice Deploys the wrapper for a fixed pool range; sqrt ratios must match ticks (computed off-chain).
     * @param initialOwner_        Contract owner (can recover stuck funds via owner functions if added later)
     * @param positionManager_     Uniswap V3 NonfungiblePositionManager address
     * @param pool_                Address of the Uniswap V3 pool
     * @param token0_              Lower-sort token of the pool pair
     * @param token1_              Higher-sort token of the pool pair
     * @param fee_                 Pool fee tier (e.g. 500, 3000, 10000)
     * @param tickLower_           Lower tick of the position range
     * @param tickUpper_           Upper tick of the position range
     * @param sqrtRatioLowerX96_   TickMath.getSqrtRatioAtTick(tickLower_) — computed off-chain
     * @param sqrtRatioUpperX96_   TickMath.getSqrtRatioAtTick(tickUpper_) — computed off-chain
     * @param executionAdapter_    UniswapV3LPExecutionAdapter that owns this wrapper
     * @param name_                ERC20 name for the wrapper shares
     * @param symbol_              ERC20 symbol for the wrapper shares
     */
    constructor(
        address initialOwner_,
        address positionManager_,
        address pool_,
        address token0_,
        address token1_,
        uint24 fee_,
        int24 tickLower_,
        int24 tickUpper_,
        uint160 sqrtRatioLowerX96_,
        uint160 sqrtRatioUpperX96_,
        address executionAdapter_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(initialOwner_) {
        _validateConstructor(
            positionManager_,
            pool_,
            token0_,
            token1_,
            executionAdapter_,
            sqrtRatioLowerX96_,
            sqrtRatioUpperX96_,
            tickLower_,
            tickUpper_
        );

        POSITION_MANAGER = IUniswapV3NonfungiblePositionManager(positionManager_);
        POOL = pool_;
        TOKEN0 = token0_;
        TOKEN1 = token1_;
        FEE = fee_;
        TICK_LOWER = tickLower_;
        TICK_UPPER = tickUpper_;
        SQRT_RATIO_LOWER_X96 = sqrtRatioLowerX96_;
        SQRT_RATIO_UPPER_X96 = sqrtRatioUpperX96_;
        EXECUTION_ADAPTER = executionAdapter_;
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IUniswapV3LPWrapper
    function totalLiquidity() public view override returns (uint128 liquidity) {
        if (tokenId == 0) return 0;
        // slither-disable-next-line unused-return
        (, , , , , , , liquidity, , , , ) = POSITION_MANAGER.positions(tokenId);
    }

    // ─── State-changing ───────────────────────────────────────────────────────

    /// @inheritdoc IUniswapV3LPWrapper
    function depositLiquidity(
        uint256 amount0,
        uint256 amount1,
        address recipient,
        uint256 minSharesOut
    ) external override onlyAdapter returns (uint256 shares, uint256 usedAmount0, uint256 usedAmount1) {
        if (amount0 == 0 && amount1 == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(TOKEN0);

        // Snapshot state BEFORE the NPM call for correct share math
        uint256 supplyBefore = totalSupply();
        uint128 liqBefore = totalLiquidity();

        _pullTokensFromAdapter(amount0, amount1);

        // Approve NPM
        IERC20(TOKEN0).forceApprove(address(POSITION_MANAGER), amount0);
        IERC20(TOKEN1).forceApprove(address(POSITION_MANAGER), amount1);

        (uint128 liquidityMinted, uint256 u0, uint256 u1) = _mintOrIncreasePosition(amount0, amount1);
        usedAmount0 = u0;
        usedAmount1 = u1;

        // Clean up approvals
        IERC20(TOKEN0).forceApprove(address(POSITION_MANAGER), 0);
        IERC20(TOKEN1).forceApprove(address(POSITION_MANAGER), 0);

        shares = _sharesForMintedLiquidity(liquidityMinted, supplyBefore, liqBefore);
        _requireMintedShares(shares, minSharesOut);

        _mint(recipient, shares);

        _refundUnusedToAdapter(amount0, amount1, usedAmount0, usedAmount1);
    }

    /// @inheritdoc IUniswapV3LPWrapper
    function withdrawLiquidity(
        uint256 shares,
        address recipient
    ) external override onlyAdapter returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));
        if (tokenId == 0) revert ErrorsLib.InvalidArguments();

        uint256 supply = totalSupply();
        uint128 liq = totalLiquidity();

        // Proportional liquidity to remove
        uint128 liquidityToRemove = uint128(uint256(liq).mulDiv(shares, supply));
        if (liquidityToRemove == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(address(this));

        // Burn shares from the execution adapter (adapter holds shares before calling)
        _burn(msg.sender, shares);

        // Remove liquidity: moves tokens from pool to NPM's owed balances
        IUniswapV3NonfungiblePositionManager.DecreaseLiquidityParams
            memory decreaseParams = IUniswapV3NonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidityToRemove,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            });
        // slither-disable-next-line unused-return
        POSITION_MANAGER.decreaseLiquidity(decreaseParams);

        // Collect all owed amounts (liquidity proceeds + any accumulated fees)
        IUniswapV3NonfungiblePositionManager.CollectParams memory collectParams = IUniswapV3NonfungiblePositionManager
            .CollectParams({
                tokenId: tokenId,
                recipient: recipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        (amount0, amount1) = POSITION_MANAGER.collect(collectParams);

        // Burn the NFT if the position is fully withdrawn
        if (totalLiquidity() == 0) {
            POSITION_MANAGER.burn(tokenId);
            tokenId = 0;
        }
    }

    /* solhint-disable code-complexity */
    function _validateConstructor(
        address positionManager_,
        address pool_,
        address token0_,
        address token1_,
        address executionAdapter_,
        uint160 sqrtRatioLowerX96_,
        uint160 sqrtRatioUpperX96_,
        int24 tickLower_,
        int24 tickUpper_
    ) private pure {
        if (positionManager_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (pool_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (token0_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (token1_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (executionAdapter_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (sqrtRatioLowerX96_ == 0 || sqrtRatioUpperX96_ == 0) revert ErrorsLib.InvalidArguments();
        // solhint-disable-next-line gas-strict-inequalities
        if (sqrtRatioLowerX96_ >= sqrtRatioUpperX96_) revert ErrorsLib.InvalidArguments();
        // solhint-disable-next-line gas-strict-inequalities
        if (tickLower_ >= tickUpper_) revert ErrorsLib.InvalidArguments();
    }

    /* solhint-enable code-complexity */

    function _pullTokensFromAdapter(uint256 amount0, uint256 amount1) private {
        if (amount0 > 0) IERC20(TOKEN0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(TOKEN1).safeTransferFrom(msg.sender, address(this), amount1);
    }

    function _sharesForMintedLiquidity(
        uint128 liquidityMinted,
        uint256 supplyBefore,
        uint128 liqBefore
    ) private view returns (uint256) {
        if (supplyBefore == 0 || liqBefore == 0) {
            return uint256(liquidityMinted);
        }
        return uint256(liquidityMinted).mulDiv(supplyBefore, uint256(liqBefore));
    }

    function _refundUnusedToAdapter(uint256 amount0, uint256 amount1, uint256 used0, uint256 used1) private {
        uint256 unused0 = amount0 - used0;
        uint256 unused1 = amount1 - used1;
        if (unused0 > 0) IERC20(TOKEN0).safeTransfer(msg.sender, unused0);
        if (unused1 > 0) IERC20(TOKEN1).safeTransfer(msg.sender, unused1);
    }

    function _requireMintedShares(uint256 shares, uint256 minSharesOut) private view {
        if (shares == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(TOKEN0);
        if (minSharesOut != 0 && shares < minSharesOut) {
            revert ErrorsLib.LPShareMintBelowMinimum(address(this), shares, minSharesOut);
        }
    }

    /// @dev Mint a new NFT position or increase liquidity on the existing `tokenId`.
    function _mintOrIncreasePosition(
        uint256 amount0,
        uint256 amount1
    ) private returns (uint128 liquidityMinted, uint256 usedAmount0, uint256 usedAmount1) {
        if (tokenId == 0) {
            IUniswapV3NonfungiblePositionManager.MintParams memory mintParams = IUniswapV3NonfungiblePositionManager
                .MintParams({
                    token0: TOKEN0,
                    token1: TOKEN1,
                    fee: FEE,
                    tickLower: TICK_LOWER,
                    tickUpper: TICK_UPPER,
                    amount0Desired: amount0,
                    amount1Desired: amount1,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: address(this),
                    deadline: block.timestamp
                });
            // slither-disable-next-line unused-return
            (tokenId, liquidityMinted, usedAmount0, usedAmount1) = POSITION_MANAGER.mint(mintParams);
        } else {
            IUniswapV3NonfungiblePositionManager.IncreaseLiquidityParams
                memory incParams = IUniswapV3NonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId: tokenId,
                    amount0Desired: amount0,
                    amount1Desired: amount1,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                });
            (liquidityMinted, usedAmount0, usedAmount1) = POSITION_MANAGER.increaseLiquidity(incParams);
        }
    }
}
