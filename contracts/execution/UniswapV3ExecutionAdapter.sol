// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { IQuoterV2 } from "@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title UniswapV3ExecutionAdapter
 * @notice Execution adapter for Uniswap V3 pools
 * @author Orion Finance
 *
 * @dev Security design: sell() and buy() are intentionally permissionless because this adapter
 *      is a low-level swap component called by higher-level adapters (e.g. ERC4626ExecutionAdapter)
 *      rather than directly by the LiquidityOrchestrator. Access control is enforced upstream:
 *      LO (onlyAuthorizedTrigger) → ERC4626ExecutionAdapter (onlyLiquidityOrchestrator) → this adapter.
 *
 *      amountOutMinimum is set to 0 at the Uniswap level because slippage protection is enforced
 *      by the LiquidityOrchestrator after execution via _calculateMinWithSlippage / _calculateMaxWithSlippage.
 *      This avoids duplicating slippage checks and keeps the slippage tolerance centralized in the LO.
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract UniswapV3ExecutionAdapter is IExecutionAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Uniswap V3 Factory contract
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;

    /// @notice Uniswap V3 SwapRouter contract
    ISwapRouter public immutable SWAP_ROUTER;

    /// @notice Uniswap V3 QuoterV2 contract
    IQuoterV2 public immutable QUOTER;

    /// @notice Orion Config contract
    IOrionConfig public immutable CONFIG;

    /// @notice Protocol underlying asset
    address public immutable UNDERLYING_ASSET;

    /// @notice asset => Uniswap V3 pool fee tier
    mapping(address => uint24) public assetFee;

    /// @dev Restricts function to only owner or guardian
    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != CONFIG.guardian()) {
            revert ErrorsLib.NotAuthorized();
        }
        _;
    }

    /**
     * @notice Constructor
     * @param initialOwner_ The address of the initial owner
     * @param factoryAddress Uniswap V3 Factory address
     * @param swapRouterAddress Uniswap V3 SwapRouter address
     * @param quoterAddress Uniswap V3 QuoterV2 address
     * @param configAddress OrionConfig contract address
     */
    constructor(
        address initialOwner_,
        address factoryAddress,
        address swapRouterAddress,
        address quoterAddress,
        address configAddress
    ) Ownable(initialOwner_) {
        if (initialOwner_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (factoryAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (swapRouterAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (quoterAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        UNISWAP_V3_FACTORY = IUniswapV3Factory(factoryAddress);
        SWAP_ROUTER = ISwapRouter(swapRouterAddress);
        QUOTER = IQuoterV2(quoterAddress);
        CONFIG = IOrionConfig(configAddress);
        UNDERLYING_ASSET = address(CONFIG.underlyingAsset());
    }

    /// @notice Sets the fee tier for a given asset
    /// @param asset The address of the asset
    /// @param fee The fee tier to set
    function setAssetFee(address asset, uint24 fee) external onlyOwnerOrGuardian {
        if (asset == address(0)) revert ErrorsLib.ZeroAddress();

        address pool = UNISWAP_V3_FACTORY.getPool(asset, address(UNDERLYING_ASSET), fee);

        if (pool == address(0)) revert ErrorsLib.InvalidAdapter(asset);

        assetFee[asset] = fee;
    }

    /// @inheritdoc IExecutionAdapter
    function validateExecutionAdapter(address asset) external view override {
        if (assetFee[asset] == 0) revert ErrorsLib.InvalidAdapter(asset);
    }

    /// @inheritdoc IExecutionAdapter
    /// @dev Permissionless by design — called by ERC4626ExecutionAdapter, not directly by LO.
    ///      amountOutMinimum = 0 because slippage is enforced by LO after execution.
    function sell(address asset, uint256 amount) external override returns (uint256 receivedAmount) {
        // Pull input from caller
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // Approve router
        IERC20(asset).forceApprove(address(SWAP_ROUTER), amount);

        // Execute exact input swap (amountOutMinimum=0: slippage checked by LO post-execution)
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: asset,
            tokenOut: UNDERLYING_ASSET,
            fee: assetFee[asset],
            recipient: msg.sender,
            deadline: block.timestamp,
            amountIn: amount,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });

        receivedAmount = SWAP_ROUTER.exactInputSingle(params);

        // Clean up approval
        IERC20(asset).forceApprove(address(SWAP_ROUTER), 0);
    }

    /// @inheritdoc IExecutionAdapter
    function previewBuy(address asset, uint256 amount) external override returns (uint256 underlyingAmount) {
        // slither-disable-next-line unused-return
        (underlyingAmount, , , ) = QUOTER.quoteExactOutputSingle(
            IQuoterV2.QuoteExactOutputSingleParams({
                tokenIn: UNDERLYING_ASSET,
                tokenOut: asset,
                amount: amount,
                fee: assetFee[asset],
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// @inheritdoc IExecutionAdapter
    /// @dev Permissionless by design — called by ERC4626ExecutionAdapter, not directly by LO.
    ///      amountInMaximum is derived from caller's approval; slippage enforced by LO post-execution.
    function buy(address asset, uint256 amount) external override returns (uint256 spentAmount) {
        // Caller must have approved the underlying amount (from previewBuy result).
        // Reading allowance avoids a redundant Quoter call when called from ERC4626ExecutionAdapter.
        uint256 amountInMaximum = IERC20(UNDERLYING_ASSET).allowance(msg.sender, address(this));

        // Pull approved amount from caller
        IERC20(UNDERLYING_ASSET).safeTransferFrom(msg.sender, address(this), amountInMaximum);

        // Approve router
        IERC20(UNDERLYING_ASSET).forceApprove(address(SWAP_ROUTER), amountInMaximum);

        // Execute exact output swap
        ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
            tokenIn: UNDERLYING_ASSET,
            tokenOut: asset,
            fee: assetFee[asset],
            recipient: msg.sender,
            deadline: block.timestamp,
            amountOut: amount,
            amountInMaximum: amountInMaximum,
            sqrtPriceLimitX96: 0
        });

        spentAmount = SWAP_ROUTER.exactOutputSingle(params);

        // Refund unused underlying to caller (triggered when max+slippage was approved;
        // zero-cost in atomic previewBuy→buy flows since spentAmount == amountInMaximum)
        if (spentAmount < amountInMaximum) {
            IERC20(UNDERLYING_ASSET).safeTransfer(msg.sender, amountInMaximum - spentAmount);
        }

        // Clean up approval
        IERC20(UNDERLYING_ASSET).forceApprove(address(SWAP_ROUTER), 0);
    }
}
