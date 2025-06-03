// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OrionConfig {
    address public owner;
    string public fhePublicCID;

    mapping(address => bool) public isWhitelisted;
    address[] public allVaults;

    // Events
    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);
    event PublicCIDUpdated(string newCID);

    // Modifier
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // Constructor
    constructor(string memory _fhePublicCID) {
        owner = msg.sender;
        fhePublicCID = _fhePublicCID;
    }

    // ERC4626 Vault Whitelist Functions
    function addVault(address vault) external onlyOwner {
        require(!isWhitelisted[vault], "Already whitelisted");
        isWhitelisted[vault] = true;
        allVaults.push(vault);
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

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function getWhitelistedVaults() external view returns (address[] memory) {
        uint count = 0;

        // First pass to count
        for (uint i = 0; i < allVaults.length; i++) {
            if (isWhitelisted[allVaults[i]]) {
                count++;
            }
        }

        // Second pass to collect
        address[] memory result = new address[](count);
        uint index = 0;
        for (uint i = 0; i < allVaults.length; i++) {
            if (isWhitelisted[allVaults[i]]) {
                result[index] = allVaults[i];
                index++;
            }
        }

        return result;
    }

    // FHE Public CID Functions
    function getFhePublicCID() external view returns (string memory) {
        return fhePublicCID;
    }

    function updateFhePublicCID(string calldata newCID) external onlyOwner {
        fhePublicCID = newCID;
        emit PublicCIDUpdated(newCID);
    }

    // Ownership management
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}
