// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title ErrorsLib
/// @notice Library exposing error messages.
library ErrorsLib {
    error NotFactory();
    error ZeroAddress();
    error InvalidAsset();
    error AlreadyWhitelisted();
    error AlreadyAnOrionVault();
    error NotAnOrionVault();
    error InvalidCuratorAddress();
    error InvalidConfigAddress();
    error NotCurator();
    error NotLiquidityOrchestrator();
    error NotInternalStatesOrchestrator();
    error TransferFailed();
    error TokenNotWhitelisted(address token);
    error AmountMustBeGreaterThanZero(address asset);
    error SharesMustBeGreaterThanZero();
    error NotEnoughShares();
    error SynchronousCallDisabled();
    error InvalidTotalWeight();
    error OrderIntentCannotBeEmpty();
    error TokenAlreadyInOrder(address token);
    error NotAuthorized();
    error TooEarly();
    error NotEnoughDepositRequest();
    error AdapterNotSet();
    error InvalidStatesDecimals();
}
