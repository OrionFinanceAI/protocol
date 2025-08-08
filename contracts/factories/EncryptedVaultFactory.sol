// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IOrionConfig.sol";
import "../vaults/OrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title EncryptedVaultFactory
 * @notice A factory contract for creating Orion encrypted vaults
 * @dev This contract is responsible for creating new encrypted vaults only.
 */
contract EncryptedVaultFactory {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
    }

    /// @notice Creates a new encrypted vault
    /// @param curator The address of the curator
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @return vault The address of the new encrypted vault
    function createVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        address vaultOwner = msg.sender;

        if (vaultOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        OrionEncryptedVault encryptedVault = new OrionEncryptedVault(vaultOwner, curator, config, name, symbol);
        vault = address(encryptedVault);

        config.addOrionVault(vault, EventsLib.VaultType.Encrypted);
        emit EventsLib.OrionVaultCreated(vault, vaultOwner, curator, EventsLib.VaultType.Encrypted);
    }
}
