// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title ErrorsLib
/// @notice Library exposing error messages.
library ErrorsLib {
    error NotOwner();
    error NotFactory();
    error ZeroAddress();
    error InvalidAsset();
    error InvalidInternalOrchestrator();
    error InvalidLiquidityOrchestrator();
    error AlreadyWhitelisted();
    error NotInWhitelist();
    error IndexOutOfBounds();
    error VaultNotFound();
    error OrionVaultNotFound();
    error AlreadyAnOrionVault();
    error NotAnOrionVault();
    error InvalidCuratorAddress();
    error InvalidConfigAddress();
    error UnderlyingAssetNotSet();
    error NotCurator();
    error NotLiquidityOrchestrator();
    error NotInternalStatesOrchestrator();
    error TransferFailed();
    error TokenNotWhitelisted(address token);
    error AmountMustBeGreaterThanZero(address asset);
    error SharesMustBeGreaterThanZero();
    error NotEnoughShares();
    error SynchronousRedemptionsDisabled();
    error SynchronousDepositsDisabled();
    error SynchronousWithdrawalsDisabled();
    error InvalidTotalWeight();
    error ZeroPrice();
    error OrderIntentCannotBeEmpty();
    error TokenAlreadyInOrder(address token);
    error CuratorCannotBeZeroAddress();
    error NotAuthorized();
    error TooEarly();
    error DepositRequestFailed();
    error WithdrawRequestFailed();
    error NotEnoughDepositRequest();
    error OracleNotSet();
    error OracleNotInitialized();
    error InvalidStatesDecimals();
}
