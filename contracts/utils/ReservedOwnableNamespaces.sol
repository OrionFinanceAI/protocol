// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/**
 * @title ReservedOwnableNamespaces
 * @notice Reserves OpenZeppelin Ownable / Ownable2Step ERC-7201 storage namespaces.
 */
abstract contract ReservedOwnableNamespaces {
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorage {
        address _owner;
    }

    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable2Step
    struct Ownable2StepStorage {
        address _pendingOwner;
    }
}
