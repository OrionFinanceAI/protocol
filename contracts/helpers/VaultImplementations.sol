// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../vaults/OrionTransparentVault.sol";
import "../vaults/OrionEncryptedVault.sol";

/**
 * @title VaultImplementations
 * @dev Helper contract to deploy vault implementations separately from the factory
 * This reduces the OrionVaultFactory contract size (spurious dragon) by not embedding implementation bytecode.
 */
contract VaultImplementations {
    address public immutable TRANSPARENT_VAULT_IMPLEMENTATION;
    address public immutable ENCRYPTED_VAULT_IMPLEMENTATION;

    constructor() {
        // Deploy implementation contracts
        TRANSPARENT_VAULT_IMPLEMENTATION = address(new OrionTransparentVault());
        ENCRYPTED_VAULT_IMPLEMENTATION = address(new OrionEncryptedVault());
    }
}
