// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

contract OrionVaultFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    enum VaultType {
        Transparent,
        Encrypted
    }

    address public deployer;
    IOrionConfig public config;

    // Implementation addresses for vault types
    address public transparentVaultImplementation;
    address public encryptedVaultImplementation;

    event OrionVaultCreated(
        address indexed vault,
        address indexed curator,
        address indexed deployer,
        VaultType vaultType
    );

    function initialize(address initialOwner, address _config) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(initialOwner);

        deployer = msg.sender;
        config = IOrionConfig(_config);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function updateConfig(address _newConfig) external onlyOwner {
        config = IOrionConfig(_newConfig);
    }

    function setImplementations(address _transparentImpl, address _encryptedImpl) external onlyOwner {
        if (_transparentImpl == address(0)) revert ErrorsLib.ZeroAddress();
        if (_encryptedImpl == address(0)) revert ErrorsLib.ZeroAddress();

        transparentVaultImplementation = _transparentImpl;
        encryptedVaultImplementation = _encryptedImpl;
    }

    function createOrionTransparentVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (transparentVaultImplementation == address(0)) revert ErrorsLib.ZeroAddress();

        // Create proxy for transparent vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(transparentVaultImplementation, initData);
        vault = address(proxy);

        emit OrionVaultCreated(vault, curator, msg.sender, VaultType.Transparent);
        config.addOrionVault(vault);
    }

    function createOrionEncryptedVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedVaultImplementation == address(0)) revert ErrorsLib.ZeroAddress();

        // Create proxy for encrypted vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(encryptedVaultImplementation, initData);
        vault = address(proxy);

        emit OrionVaultCreated(vault, curator, msg.sender, VaultType.Encrypted);
        config.addOrionVault(vault);
    }
}
