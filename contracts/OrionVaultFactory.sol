// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./OrionTransparentVault.sol";
import "./OrionEncryptedVault.sol";
import "./interfaces/IOrionConfig.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

contract OrionVaultFactory {
    address public deployer;
    IOrionConfig public config;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer, string vaultType);

    constructor(address _config) {
        deployer = msg.sender;
        config = IOrionConfig(_config);
    }

    function createOrionTransparentVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.CuratorCannotBeZeroAddress();

        OrionTransparentVault newVault = new OrionTransparentVault(curator, config, name, symbol);
        vault = address(newVault);

        emit OrionVaultCreated(vault, curator, msg.sender, "transparent");
        config.addOrionVault(vault);
    }

    function createOrionEncryptedVault(
        address curator,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        if (curator == address(0)) revert ErrorsLib.CuratorCannotBeZeroAddress();

        OrionEncryptedVault newVault = new OrionEncryptedVault(curator, config, name, symbol);
        vault = address(newVault);

        emit OrionVaultCreated(vault, curator, msg.sender, "encrypted");
        config.addOrionVault(vault);
    }
}
