// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

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
 * @custom:security-contact security@orionfinance.ai
 */
contract MorphoBlueSupplyVault is ERC4626 {
    using SafeERC20 for IERC20;
    using MorphoBalancesLib for IMorpho;
    using MarketParamsLib for MarketParams;

    /// @notice Morpho Blue singleton
    IMorpho public immutable MORPHO;

    /// @notice Market id derived from `marketParams` at construction
    Id public immutable MARKET_ID;

    /// @notice Morpho Blue market parameters
    MarketParams public marketParams;

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
        marketParams = marketParams_;
        MARKET_ID = marketParams_.id();

        Market memory mkt = IMorpho(morpho_).market(MARKET_ID);
        if (mkt.lastUpdate == 0) revert ErrorsLib.InvalidArguments();
    }

    /// @inheritdoc IERC4626
    function totalAssets() public view override returns (uint256) {
        return MORPHO.expectedSupplyAssets(marketParams, address(this));
    }

    /// @inheritdoc IERC4626
    /// @dev Caps the owner's withdrawable assets by Morpho market liquidity so this function never
    ///      returns a value that would cause withdraw() to revert, as required by ERC-4626.
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 ownerAssets = convertToAssets(balanceOf(owner));
        // slither-disable-next-line unused-return
        (uint256 totalSupplyAssets, , uint256 totalBorrowAssets, ) = MORPHO.expectedMarketBalances(marketParams);
        uint256 availableLiquidity = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0;
        return ownerAssets < availableLiquidity ? ownerAssets : availableLiquidity;
    }

    /// @inheritdoc IERC4626
    /// @dev Computed directly in shares to avoid the double floor rounding that would occur if derived
    ///      from maxWithdraw: convertToShares(convertToAssets(shares)) can return shares - 1.
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 ownerShares = balanceOf(owner);
        // slither-disable-next-line unused-return
        (uint256 totalSupplyAssets, , uint256 totalBorrowAssets, ) = MORPHO.expectedMarketBalances(marketParams);
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
        MORPHO.supply(marketParams, assets, 0, address(this), "");
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
        MORPHO.withdraw(marketParams, assets, 0, address(this), receiver);

        emit Withdraw(caller, receiver, owner, assets, shares);
    }
}
