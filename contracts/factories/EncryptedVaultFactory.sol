// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IOrionConfig.sol";
import "../vaults/OrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title EncryptedVaultFactory
 * @notice A factory contract for creating Orion encrypted vaults
 * @author Orion Finance
 * @dev This contract is responsible for creating new encrypted vaults only.
 */
contract EncryptedVaultFactory {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Constructor
    /// @param configAddress The address of the OrionConfig contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
    }

    /// @notice Creates a new encrypted vault
    /// @param curator The address of the curator
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @return vault The address of the new encrypted vault
    function createVault(
        address curator,
        string calldata name,
        string calldata symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee
    ) external returns (address vault) {
        address vaultOwner = msg.sender;

        if (vaultOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        OrionEncryptedVault encryptedVault = new OrionEncryptedVault(
            vaultOwner,
            curator,
            config,
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee
        );
        vault = address(encryptedVault);

        config.addOrionVault(vault, EventsLib.VaultType.Encrypted);
        emit EventsLib.OrionVaultCreated(
            vault,
            vaultOwner,
            curator,
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee,
            EventsLib.VaultType.Encrypted
        );
    }
}
