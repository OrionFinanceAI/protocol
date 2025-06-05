// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FHEIntentsERC4626Vault.sol";
import "./OrionConfig.sol";

contract OrionVaultFactory {
    address public deployer;
    OrionConfig public config;

    address[] public allOrionVaults;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    constructor(address _config) {
        require(_config != address(0), "Invalid config address");
        deployer = msg.sender;
        config = OrionConfig(_config);
    }


    function createOrionVault(address curator) external returns (address vault) {
        require(curator != address(0), "Curator cannot be zero address");

        FHEIntentsERC4626Vault newVault = new FHEIntentsERC4626Vault(
            curator,
            address(config)
        );

        vault = address(newVault);
        allOrionVaults.push(vault);

        emit OrionVaultCreated(vault, curator, msg.sender);
    }

    function getOrionVaultAt(uint256 index) external view returns (address) {
        require(index < allOrionVaults.length, "Index out of bounds");
        return allOrionVaults[index];
    }

    function _exists(address vault) internal view returns (bool) {
        for (uint256 i = 0; i < allOrionVaults.length; i++) {
            if (allOrionVaults[i] == vault) {
                return true;
            }
        }
        return false;
    }
}
