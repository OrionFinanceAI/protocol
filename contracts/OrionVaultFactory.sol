// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OrionTransparentVault.sol";
import "./interfaces/IOrionConfig.sol";

contract OrionVaultFactory {
    address public deployer;
    IOrionConfig public config;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    error CuratorCannotBeZeroAddress();
    error InvalidConfigAddress();

    constructor(address _config) {
        if (_config == address(0)) revert InvalidConfigAddress();
        deployer = msg.sender;
        config = IOrionConfig(_config);
    }

    function createOrionTransparentVault(address curator) external returns (address vault) {
        if (curator == address(0)) revert CuratorCannotBeZeroAddress();

        OrionTransparentVault newVault = new OrionTransparentVault(curator, address(config));
        vault = address(newVault);

        emit OrionVaultCreated(vault, curator, msg.sender);
        config.addOrionVault(vault);
    }
}
