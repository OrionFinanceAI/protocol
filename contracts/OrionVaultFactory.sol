// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./OrionTransparentVault.sol";
import "./interfaces/IOrionConfig.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

contract OrionVaultFactory {
    address public deployer;
    IOrionConfig public config;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    constructor(address _config) {
        if (_config == address(0)) revert ErrorsLib.InvalidConfigAddress();
        deployer = msg.sender;
        config = IOrionConfig(_config);
    }

    function createOrionTransparentVault(address curator) external returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.CuratorCannotBeZeroAddress();

        OrionTransparentVault newVault = new OrionTransparentVault(curator, address(config));
        vault = address(newVault);

        emit OrionVaultCreated(vault, curator, msg.sender);
        config.addOrionVault(vault);
    }
}
