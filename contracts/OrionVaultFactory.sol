// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OrionVault.sol"; // TODO: add IOrionVault interface for protocol upgradeability.
import "./OrionConfig.sol"; // TODO: add IOrionConfig interface for protocol upgradeability.

contract OrionVaultFactory {
    address public deployer;
    OrionConfig public config;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    error CuratorCannotBeZeroAddress();
    error InvalidConfigAddress();

    constructor(address _config) {
        if (_config == address(0)) revert InvalidConfigAddress();
        deployer = msg.sender;
        config = OrionConfig(_config);
    }

    function createOrionVault(address curator) external returns (address vault) {
        if (curator == address(0)) revert CuratorCannotBeZeroAddress();

        OrionVault newVault = new OrionVault(curator, address(config));
        vault = address(newVault);

        emit OrionVaultCreated(vault, curator, msg.sender);
        config.addOrionVault(vault);
    }
}
