// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "../OrionTransparentVault.sol";
import "../OrionEncryptedVault.sol";

/**
 * @title VaultImplementations
 * @dev Helper contract to deploy vault implementations separately from the factory
 * This reduces the OrionVaultFactory contract size (spurious dragon) by not embedding implementation bytecode.
 */
contract VaultImplementations {
    address public immutable transparentVaultImplementation;
    address public immutable encryptedVaultImplementation;

    constructor() {
        // Deploy implementation contracts
        transparentVaultImplementation = address(new OrionTransparentVault());
        encryptedVaultImplementation = address(new OrionEncryptedVault());
    }
}
