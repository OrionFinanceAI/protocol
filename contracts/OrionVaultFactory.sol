// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OrionVault.sol";
import "./OrionConfig.sol";

contract OrionVaultFactory {
    address public deployer;
    OrionConfig public config;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    constructor(address _config) {
        require(_config != address(0), "Invalid config address");
        deployer = msg.sender;
        config = OrionConfig(_config);
    }


    function createOrionVault(address curator) external returns (address vault) {
        require(curator != address(0), "Curator cannot be zero address");

        OrionVault newVault = new OrionVault(
            curator,
            address(config)
        );
        vault = address(newVault);

        emit OrionVaultCreated(vault, curator, msg.sender);
        // config.addOrionVault(vault);
    }
}
