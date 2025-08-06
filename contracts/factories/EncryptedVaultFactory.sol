// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import "../vaults/OrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title EncryptedVaultFactory
 * @notice A factory contract for creating Orion encrypted vaults
 * @dev This contract is responsible for creating new encrypted vaults only.
 */
contract EncryptedVaultFactory is Ownable {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    constructor(address initialOwner, address configAddress) Ownable(initialOwner) {
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
    ) external onlyOwner returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        OrionEncryptedVault encryptedVault = new OrionEncryptedVault(curator, config, name, symbol);
        vault = address(encryptedVault);

        config.addOrionVault(vault, EventsLib.VaultType.Encrypted);
        emit EventsLib.OrionVaultCreated(vault, curator, msg.sender, EventsLib.VaultType.Encrypted);
    }
}
