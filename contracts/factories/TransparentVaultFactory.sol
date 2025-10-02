// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IOrionConfig.sol";
import "../vaults/OrionTransparentVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title TransparentVaultFactory
 * @notice A factory contract for creating Orion transparent vaults
 * @author Orion Finance
 * @dev This contract is responsible for creating new transparent vaults only.
 */
contract TransparentVaultFactory {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice Constructor
    /// @param configAddress The address of the OrionConfig contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
    }

    /// @notice Creates a new transparent vault
    /// @param curator The address of the vault curator
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @return vault The address of the new transparent vault
    function createVault(
        address curator,
        string calldata name,
        string calldata symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee
    ) external returns (address vault) {
        address vaultOwner = msg.sender;

        if (!config.isWhitelistedVaultOwner(vaultOwner)) revert ErrorsLib.UnauthorizedAccess();
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        OrionTransparentVault transparentVault = new OrionTransparentVault(
            vaultOwner,
            curator,
            config,
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee
        );
        vault = address(transparentVault);

        config.addOrionVault(vault, EventsLib.VaultType.Transparent);
        emit EventsLib.OrionVaultCreated(
            vault,
            vaultOwner,
            curator,
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee,
            EventsLib.VaultType.Transparent
        );
    }
}
