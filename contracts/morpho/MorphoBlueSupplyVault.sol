// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IMorpho, MarketParams, Id, Market } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { MorphoBalancesLib } from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import { MarketParamsLib } from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

/**
 * @title MorphoBlueSupplyVault
 * @notice Minimal ERC-4626 wrapper over a single Morpho Blue supply-side position.
 * @author Orion Finance
 * @dev One deployment per market. Deposits are supplied to Morpho; withdrawals pull directly to the
 *      receiver. Supply-only — no borrow or collateral positions.
 *
 *      Market parameters are stored as individual immutables rather than a storage struct so that
 *      every Morpho call avoids five SLOADs when copying them into memory.
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract MorphoBlueSupplyVault is ERC4626 {
    using SafeERC20 for IERC20;
    using MorphoBalancesLib for IMorpho;
    using MarketParamsLib for MarketParams;

    /// @notice Morpho Blue singleton
    IMorpho public immutable MORPHO;

    /// @notice Market id derived from the market parameters at construction
    Id public immutable MARKET_ID;

    // ── Market parameters (immutable to avoid per-call SLOADs) ────────────────

    /// @notice Loan token of the Morpho market (= ERC-4626 underlying asset)
    address public immutable LOAN_TOKEN;

    /// @notice Collateral token of the Morpho market
    address public immutable COLLATERAL_TOKEN;

    /// @notice Price oracle of the Morpho market
    address public immutable ORACLE;

    /// @notice Interest rate model of the Morpho market
    address public immutable IRM;

    /// @notice Liquidation loan-to-value ratio of the Morpho market (scaled by 1e18)
    uint256 public immutable LLTV;

    /**
     * @notice Constructor
     * @param morpho_ Morpho Blue singleton
     * @param marketParams_ Market parameters (loanToken, collateralToken, oracle, irm, lltv)
     * @param name_ ERC-20 name for vault shares
     * @param symbol_ ERC-20 symbol for vault shares
     */
    constructor(
        address morpho_,
        MarketParams memory marketParams_,
        string memory name_,
        string memory symbol_
    ) ERC4626(IERC20(marketParams_.loanToken)) ERC20(name_, symbol_) {
        if (morpho_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (marketParams_.loanToken == address(0)) revert ErrorsLib.ZeroAddress();

        MORPHO = IMorpho(morpho_);
        MARKET_ID = marketParams_.id();

        LOAN_TOKEN = marketParams_.loanToken;
        COLLATERAL_TOKEN = marketParams_.collateralToken;
        ORACLE = marketParams_.oracle;
        IRM = marketParams_.irm;
        LLTV = marketParams_.lltv;

        Market memory mkt = IMorpho(morpho_).market(MARKET_ID);
        if (mkt.lastUpdate == 0) revert ErrorsLib.InvalidArguments();
    }

    /// @inheritdoc IERC4626
    function totalAssets() public view override returns (uint256) {
        return MORPHO.expectedSupplyAssets(_mp(), address(this));
    }

    /// @inheritdoc IERC4626
    /// @dev Caps the owner's withdrawable assets by Morpho market liquidity so this function never
    ///      returns a value that would cause withdraw() to revert, as required by ERC-4626.
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 ownerAssets = convertToAssets(balanceOf(owner));
        // slither-disable-next-line unused-return
        (uint256 totalSupplyAssets, , uint256 totalBorrowAssets, ) = MORPHO.expectedMarketBalances(_mp());
        uint256 availableLiquidity = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0;
        return ownerAssets < availableLiquidity ? ownerAssets : availableLiquidity;
    }

    /// @inheritdoc IERC4626
    /// @dev Computed directly in shares to avoid the double floor rounding that would occur if derived
    ///      from maxWithdraw: convertToShares(convertToAssets(shares)) can return shares - 1.
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 ownerShares = balanceOf(owner);
        // slither-disable-next-line unused-return
        (uint256 totalSupplyAssets, , uint256 totalBorrowAssets, ) = MORPHO.expectedMarketBalances(_mp());
        uint256 availableLiquidity = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0;
        uint256 availableShares = convertToShares(availableLiquidity);
        return ownerShares < availableShares ? ownerShares : availableShares;
    }

    /// @notice Supplies `assets` to Morpho and mints `shares` to `receiver`.
    /// @param caller Address that initiated the deposit
    /// @param receiver Address that receives the vault shares
    /// @param assets Amount of loanToken to supply
    /// @param shares Amount of vault shares to mint
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(asset()).safeTransferFrom(caller, address(this), assets);

        IERC20(asset()).forceApprove(address(MORPHO), assets);
        // slither-disable-next-line unused-return
        MORPHO.supply(_mp(), assets, 0, address(this), "");
        IERC20(asset()).forceApprove(address(MORPHO), 0);

        _mint(receiver, shares);

        emit Deposit(caller, receiver, assets, shares);
    }

    /// @notice Burns `shares` from `owner` and withdraws `assets` from Morpho directly to `receiver`.
    /// @param caller Address that initiated the withdrawal
    /// @param receiver Address that receives the loanToken
    /// @param owner Address whose shares are burned
    /// @param assets Amount of loanToken to withdraw from Morpho
    /// @param shares Amount of vault shares to burn
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }

        _burn(owner, shares);

        // slither-disable-next-line unused-return
        MORPHO.withdraw(_mp(), assets, 0, address(this), receiver);

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Reconstructs the MarketParams struct from immutables for each Morpho call.
    ///      Using immutables avoids 5 SLOADs per call compared to a storage struct.
    function _mp() private view returns (MarketParams memory) {
        return
            MarketParams({
                loanToken: LOAN_TOKEN,
                collateralToken: COLLATERAL_TOKEN,
                oracle: ORACLE,
                irm: IRM,
                lltv: LLTV
            });
    }
}
