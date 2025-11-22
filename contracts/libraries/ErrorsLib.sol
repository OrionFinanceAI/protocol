// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title ErrorsLib
/// @notice Centralized library for reusable custom errors across the protocol.
/// @author Orion Finance
library ErrorsLib {
    /// @notice Caller is not authorized to perform the requested action.
    error NotAuthorized();

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

    /// @notice The adapter is not compatible with the asset.
    /// @param asset The asset address that is not compatible with the adapter.
    error InvalidAdapter(address asset);

    /// @notice Execution failed.
    /// @param asset The asset address that failed to execute.
    error ExecutionFailed(address asset);

    /// @notice Operation cannot be performed because the system is not idle.
    error SystemNotIdle();

    /// @notice Transfer of tokens failed.
    error TransferFailed();

    /// @notice The curator contract does not properly implement the required interface.
    error InvalidCuratorContract();

    /// @notice The strategy is not compatible with the provided whitelisted assets.
    error InvalidStrategy();

    /// @notice Vault is decommissioned and cannot accept new requests.
    error VaultDecommissioned();

    /// @notice The deposit amount is below the minimum required amount.
    /// @param amount The amount that was provided.
    /// @param minimum The minimum amount required.
    error BelowMinimumDeposit(uint256 amount, uint256 minimum);

    /// @notice The redeem amount is below the minimum required amount.
    /// @param amount The amount that was provided.
    /// @param minimum The minimum amount required.
    error BelowMinimumRedeem(uint256 amount, uint256 minimum);

    /// @notice Deposit not allowed due to access control restrictions.
    error DepositNotAllowed();

    /// @notice The provided access control contract address is invalid.
    error InvalidAccessControl();
}
