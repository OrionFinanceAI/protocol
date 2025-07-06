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

    function updateConfig(address newConfig) external onlyOwner {
        config = IOrionConfig(newConfig);
    }

    function setImplementations(address transparentImpl, address encryptedImpl) external onlyOwner {
        if (transparentImpl == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedImpl == address(0)) revert ErrorsLib.ZeroAddress();

        transparentVaultImplementation = transparentImpl;
        encryptedVaultImplementation = encryptedImpl;
    }

    function createOrionTransparentVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external nonReentrant returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (transparentVaultImplementation == address(0)) revert ErrorsLib.ZeroAddress();

        // Create proxy for transparent vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(transparentVaultImplementation, initData);
        vault = address(proxy);
        config.addOrionVault(vault, EventsLib.VaultType.Transparent);

        emit EventsLib.OrionVaultCreated(vault, curator, msg.sender, EventsLib.VaultType.Transparent);
    }

    function createOrionEncryptedVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external nonReentrant returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedVaultImplementation == address(0)) revert ErrorsLib.ZeroAddress();

        // Create proxy for encrypted vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(encryptedVaultImplementation, initData);
        vault = address(proxy);
        config.addOrionVault(vault, EventsLib.VaultType.Encrypted);

        emit EventsLib.OrionVaultCreated(vault, curator, msg.sender, EventsLib.VaultType.Encrypted);
    }
}
