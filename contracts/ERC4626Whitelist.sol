// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract UniverseERC4626Whitelist {
    address public owner;
    mapping(address => bool) public isWhitelisted;

    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function addVault(address vault) external onlyOwner {
        require(!isWhitelisted[vault], "Already whitelisted");
        isWhitelisted[vault] = true;
        emit VaultAdded(vault);
    }

    function removeVault(address vault) external onlyOwner {
        require(isWhitelisted[vault], "Not in whitelist");
        isWhitelisted[vault] = false;
        emit VaultRemoved(vault);
    }

    function check(address vault) external view returns (bool) {
        return isWhitelisted[vault];
    }
}
