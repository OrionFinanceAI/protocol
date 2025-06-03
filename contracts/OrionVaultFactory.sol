// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FHEIntentsERC4626Vault.sol";

contract OrionVaultFactory {
    address public deployer;
    address public config;
    IERC20 public immutable underlyingAsset;
    address public immutable internalStateOrchestrator;
    address public immutable liquidityOrchestrator;

    address[] public allOrionVaults;
    mapping(address => bool) public isOrionVault;

    event OrionVaultCreated(address indexed vault, address indexed curator, address indexed deployer);

    constructor(
        address _config,
        IERC20 _underlyingAsset,
        address _internalStateOrchestrator,
        address _liquidityOrchestrator
    ) {
        require(_config != address(0), "Invalid config address");
        require(address(_underlyingAsset) != address(0), "Invalid underlying asset address");
        require(_internalStateOrchestrator != address(0), "Invalid InternalStateOrchestrator address");
        require(_liquidityOrchestrator != address(0), "Invalid LiquidityOrchestrator address");

        deployer = msg.sender;
        config = _config;
        underlyingAsset = _underlyingAsset;

        internalStateOrchestrator = _internalStateOrchestrator;
        liquidityOrchestrator = _liquidityOrchestrator;
    }


    function createOrionVault(address curator) external returns (address vault) {
        require(curator != address(0), "Curator cannot be zero address");

        FHEIntentsERC4626Vault newVault = new FHEIntentsERC4626Vault(
            underlyingAsset,
            curator,
            config,
            internalStateOrchestrator,
            liquidityOrchestrator,
            address(this)
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
