// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/**
 * @title UniswapV3PoolPriceAdapter
 * @notice Price adapter for raw ERC20 tokens (e.g. WETH, WBTC) priced via a Uniswap V3 pool
 *         against the protocol underlying asset (USDC).
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 *
 * @dev Derives price from sqrtPriceX96 in slot0. Supports both token orderings (USDC/asset and
 *      asset/USDC). Uses two-step mulDiv to avoid uint256 overflow.
 */

contract UniswapV3PoolPriceAdapter is IPriceAdapter, Ownable2Step {
    using Math for uint256;

    /// @notice Extra precision digits added on top of USDC decimals in the returned price.
    ///         Mirrors ERC4626PriceAdapter.PRICE_DECIMALS so PriceAdapterRegistry normalises
    ///         outputs from both adapters identically.
    uint8 public constant PRICE_DECIMALS = 10;

    /// @notice Protocol underlying asset address (USDC).
    address public immutable USDC;

    /// @notice Decimal precision of the protocol underlying asset.
    uint8 public immutable USDC_DECIMALS;

    /// @notice Maps each whitelisted asset address to its Uniswap V3 pool address.
    ///         The pool must contain the asset paired against USDC (either token order).
    mapping(address => address) public poolOf;

    /// @notice Emitted when a Uniswap V3 pool is registered for an asset.
    /// @param asset The ERC20 token being priced.
    /// @param pool  The Uniswap V3 pool used to derive the price.
    event PoolSet(address indexed asset, address indexed pool);

    /// @notice Initialises the adapter with the protocol underlying asset.
    /// @param usdc         Address of the protocol underlying asset (USDC).
    /// @param initialOwner Address authorised to register pools via setPool.
    constructor(address usdc, address initialOwner) Ownable(initialOwner) {
        if (usdc == address(0)) revert ErrorsLib.ZeroAddress();
        USDC = usdc;
        USDC_DECIMALS = IERC20Metadata(usdc).decimals();
    }

    /// @notice Register or update the Uniswap V3 pool used to price an asset.
    /// @dev The pool must have asset and USDC as its two tokens (either order).
    ///      Must be called before the asset can be validated or priced.
    /// @param asset The ERC20 token to register (must not be USDC).
    /// @param pool  Address of the Uniswap V3 pool for asset/USDC or USDC/asset.
    function setPool(address asset, address pool) external onlyOwner {
        if (asset == address(0) || pool == address(0)) revert ErrorsLib.ZeroAddress();
        poolOf[asset] = pool;
        emit PoolSet(asset, pool);
    }

    /// @inheritdoc IPriceAdapter
    /// @dev Reverts with InvalidAdapter if no pool has been registered for the asset.
    function validatePriceAdapter(address asset) external view override {
        if (poolOf[asset] == address(0)) revert ErrorsLib.InvalidAdapter(asset);
    }

    /// @inheritdoc IPriceAdapter
    /// @dev When sqrtPriceX96 is zero (pool not yet initialised) a 1:1 fallback price is
    ///      returned so whitelisting succeeds before the pool becomes active.
    ///      In all other cases the spot sqrtPriceX96 from slot0 is used; see the contract-level
    ///      @dev comment for the full derivation and overflow-avoidance strategy.
    function getPriceData(address asset) external view override returns (uint256 price, uint8 decimals) {
        // slither-disable-next-line unused-return
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(poolOf[asset]).slot0();

        decimals = PRICE_DECIMALS + USDC_DECIMALS;
        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        uint256 precisionAmount = 10 ** uint256(PRICE_DECIMALS + assetDecimals);

        if (sqrtPriceX96 == 0) {
            price = precisionAmount;
            return (price, decimals);
        }

        bool usdcIsToken0 = (IUniswapV3Pool(poolOf[asset]).token0() == USDC);

        if (usdcIsToken0) {
            // rawUSDC_per_rawAsset = 2^192 / sqrtPriceX96²
            uint256 step1 = precisionAmount.mulDiv(1 << 96, sqrtPriceX96);
            price = step1.mulDiv(1 << 96, sqrtPriceX96);
        } else {
            // rawUSDC_per_rawAsset = sqrtPriceX96² / 2^192
            uint256 step1 = precisionAmount.mulDiv(sqrtPriceX96, 1 << 96);
            price = step1.mulDiv(sqrtPriceX96, 1 << 96);
        }
    }
}
