// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title ErrorsLib
/// @notice Centralized library for reusable custom errors across the protocol.
/// @author Orion Finance
library ErrorsLib {
    /// @notice Caller is not authorized to perform the requested action.
    error UnauthorizedAccess();

    /// @notice Address parameter is the zero address.
    error ZeroAddress();

    /// @notice Address or token is already registered or whitelisted.
    error AlreadyRegistered();

    /// @notice Provided address is invalid for the specified context.
    error InvalidAddress();

    /// @notice Token is not whitelisted for the requested operation.
    /// @param token The token address that is not whitelisted.
    error TokenNotWhitelisted(address token);

    /// @notice The amount specified must be greater than zero.
    /// @param asset The asset address associated with the amount.
    error AmountMustBeGreaterThanZero(address asset);

    /// @notice The total weight assigned to assets or allocations is invalid.
    error InvalidTotalWeight();

    /// @notice The order intent list is empty and must contain at least one entry.
    error OrderIntentCannotBeEmpty();

    /// @notice Token has already been added to the order intent list.
    /// @param token The duplicate token address.
    error TokenAlreadyInOrder(address token);

    /// @notice Caller is not authorized to perform this action.
    error NotAuthorized();

    /// @notice Operation attempted before the required time or condition has been met.
    error TooEarly();

    /// @notice Insufficient amount to complete the operation.
    error InsufficientAmount();

    /// @notice Expected adapter address is not set.
    error AdapterNotSet();

    /// @notice The underlying asset has an unsupported or invalid number of decimals.
    error InvalidUnderlyingDecimals();

    /// @notice One or more function arguments are invalid.
    error InvalidArguments();

    /// @notice System is in an invalid or unexpected state.
    error InvalidState();

    /// @notice Operation cannot be performed because the system is not idle.
    error SystemNotIdle();

    /// @notice Transfer of tokens failed.
    error TransferFailed();
}
