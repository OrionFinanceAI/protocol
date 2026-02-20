// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title ErrorsLib
/// @notice Centralized library for reusable custom errors across the protocol.
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
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

    /// @notice Insufficient amount to complete the operation.
    error InsufficientAmount();

    /// @notice Expected adapter address is not set.
    error AdapterNotSet();

    /// @notice Price returned by the adapter must be greater than zero.
    /// @param asset The asset address that has a zero or invalid price.
    error PriceMustBeGreaterThanZero(address asset);

    /// @notice The underlying asset has an unsupported or invalid number of decimals.
    error InvalidUnderlyingDecimals();

    /// @notice One or more function arguments are invalid.
    error InvalidArguments();

    /// @notice The adapter is not compatible with the asset.
    /// @param asset The asset address that is not compatible with the adapter.
    error InvalidAdapter(address asset);

    /// @notice Operation cannot be performed because the system is not idle.
    error SystemNotIdle();

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

    /// @notice Slippage exceeds the configured tolerance.
    /// @param asset The asset address where slippage was detected.
    /// @param actual The actual value observed.
    /// @param expected The expected value.
    error SlippageExceeded(address asset, uint256 actual, uint256 expected);

    /// @notice Thrown when the zk proof's commitment doesn't match the onchain commitment.
    /// @param proofCommitment The commitment from the zk proof.
    /// @param onchainCommitment The commitment from the onchain.
    error CommitmentMismatch(bytes32 proofCommitment, bytes32 onchainCommitment);
}
