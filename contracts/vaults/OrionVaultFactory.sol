// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionVaultFactory
 * @notice A factory contract for creating Orion vaults
 * @dev This contract is responsible for creating new transparent and encrypted vaults.
 */
contract OrionVaultFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    address public deployer;
    IOrionConfig public config;

    // Implementation addresses for vault types
    address public transparentVaultImplementation;
    address public encryptedVaultImplementation;

    function initialize(address initialOwner, address configAddress) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        deployer = msg.sender;
        config = IOrionConfig(configAddress);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Sets the implementation addresses for the vaults
    /// @param transparentImpl The address of the transparent vault implementation
    /// @param encryptedImpl The address of the encrypted vault implementation
    function setImplementations(address transparentImpl, address encryptedImpl) external onlyOwner {
        if (transparentImpl == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedImpl == address(0)) revert ErrorsLib.ZeroAddress();

        transparentVaultImplementation = transparentImpl;
        encryptedVaultImplementation = encryptedImpl;
    }

    /// @notice Creates a new transparent vault
    /// @param curator The address of the curator
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @return vault The address of the new vault
    function createOrionTransparentVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external nonReentrant onlyOwner returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (transparentVaultImplementation == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Create proxy for transparent vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(transparentVaultImplementation, initData);
        vault = address(proxy);
        config.addOrionVault(vault, EventsLib.VaultType.Transparent);

        emit EventsLib.OrionVaultCreated(vault, curator, msg.sender, EventsLib.VaultType.Transparent);
    }

    /// @notice Creates a new encrypted vault
    /// @param curator The address of the curator
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @return vault The address of the new vault
    function createOrionEncryptedVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external nonReentrant onlyOwner returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedVaultImplementation == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Create proxy for encrypted vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(encryptedVaultImplementation, initData);
        vault = address(proxy);
        config.addOrionVault(vault, EventsLib.VaultType.Encrypted);

        emit EventsLib.OrionVaultCreated(vault, curator, msg.sender, EventsLib.VaultType.Encrypted);
    }
}
