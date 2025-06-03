// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FHEIntentsERC4626Vault.sol";

contract OrionVaultFactory {
    address public deployer;
    address public config;
    IERC20 public immutable underlyingAsset;

    // Track deployed Orion vaults
    address[] public allOrionVaults;
    mapping(address => bool) public isOrionVault;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    constructor(address _config, IERC20 _underlyingAsset) {
        require(_config != address(0), "Invalid config address");
        require(address(_underlyingAsset) != address(0), "Invalid underlying asset address");

        deployer = msg.sender;
        config = _config;
        underlyingAsset = _underlyingAsset;
    }

    function createOrionVault(address curator) external returns (address vault) {
        require(curator != address(0), "Curator cannot be zero address");

        // Deploy new Vault contract with fixed underlying asset
        FHEIntentsERC4626Vault newVault = new FHEIntentsERC4626Vault(
            underlyingAsset,
            curator,
            config
        );

        vault = address(newVault);
        allOrionVaults.push(vault);
        isOrionVault[vault] = true;

        emit OrionVaultCreated(vault, curator, msg.sender);
    }

    function getAllOrionVaults() external view returns (address[] memory) {
        return allOrionVaults;
    }
}
