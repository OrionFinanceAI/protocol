// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";

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
        require(_transparentImpl != address(0), "T0");
        require(_encryptedImpl != address(0), "E0");

        transparentVaultImplementation = _transparentImpl;
        encryptedVaultImplementation = _encryptedImpl;
    }

    function updateImplementations(address _newTransparentImpl, address _newEncryptedImpl) external onlyOwner {
        if (_newTransparentImpl != address(0)) {
            transparentVaultImplementation = _newTransparentImpl;
        }
        if (_newEncryptedImpl != address(0)) {
            encryptedVaultImplementation = _newEncryptedImpl;
        }
    }

    function createOrionTransparentVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        require(curator != address(0), "C0");
        require(transparentVaultImplementation != address(0), "TI0");

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
        require(curator != address(0), "C0");
        require(encryptedVaultImplementation != address(0), "EI0");

        // Create proxy for encrypted vault
        bytes memory initData = abi.encodeWithSelector(IOrionVault.initialize.selector, curator, config, name, symbol);

        ERC1967Proxy proxy = new ERC1967Proxy(encryptedVaultImplementation, initData);
        vault = address(proxy);

        emit OrionVaultCreated(vault, curator, msg.sender, VaultType.Encrypted);
        config.addOrionVault(vault);
    }
}
