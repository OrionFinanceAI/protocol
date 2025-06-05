// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OrionConfig {
    address public owner;

    // Protocol-wide configuration
    address public underlyingAsset;
    address public internalStateOrchestrator;
    address public liquidityOrchestrator;
    address public priceAndPnLOracle;
    string public fhePublicCID;

    address[] public whitelistedVaults;
    mapping(address => bool) public isWhitelisted;
    
    uint256 public whitelistCount;

    // Events
    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);
    event PublicCIDUpdated(string newCID);
    event ProtocolParamsUpdated(
        address underlyingAsset,
        address internalStateOrchestrator,
        address liquidityOrchestrator,
        address priceAndPnLOracle,
        string fhePublicCID
    );

    // Modifier
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // Constructor
    constructor() {
        owner = msg.sender;
    }

    // === Protocol Configuration ===

    function setProtocolParams(
        address _underlyingAsset,
        address _internalStateOrchestrator,
        address _liquidityOrchestrator,
        address _priceAndPnLOracle,
        string calldata _fhePublicCID
    ) external onlyOwner {
        require(_underlyingAsset != address(0), "Invalid asset");
        require(_internalStateOrchestrator != address(0), "Invalid internal orchestrator");
        require(_liquidityOrchestrator != address(0), "Invalid liquidity orchestrator");
        require(_priceAndPnLOracle != address(0), "Invalid price and PnL oracle");

        underlyingAsset = _underlyingAsset;
        internalStateOrchestrator = _internalStateOrchestrator;
        liquidityOrchestrator = _liquidityOrchestrator;
        priceAndPnLOracle = _priceAndPnLOracle;
        fhePublicCID = _fhePublicCID;

        emit ProtocolParamsUpdated(
            _underlyingAsset,
            _internalStateOrchestrator,
            _liquidityOrchestrator,
            _priceAndPnLOracle,
            _fhePublicCID
        );
    }

    // === Whitelist Functions ===

    function addVault(address vault) external onlyOwner {
        require(!isWhitelisted[vault], "Already whitelisted");
        whitelistedVaults.push(vault);
        isWhitelisted[vault] = true;
        whitelistCount += 1;
        emit VaultAdded(vault);
    }

    function removeVault(address vault) external onlyOwner {
        require(isWhitelisted[vault], "Not in whitelist");

        uint256 index = _indexOf(vault);
        // Swap and pop
        whitelistedVaults[index] = whitelistedVaults[whitelistedVaults.length - 1];
        whitelistedVaults.pop();
    
        isWhitelisted[vault] = false;
        whitelistCount -= 1;

        emit VaultRemoved(vault);
    }

    function getWhitelistedVaultAt(uint256 index) external view returns (address) {
        require(index < whitelistedVaults.length, "Index out of bounds");
        return whitelistedVaults[index];
    }

    function _indexOf(address vault) internal view returns (uint256) {
        for (uint i = 0; i < whitelistedVaults.length; i++) {
            if (whitelistedVaults[i] == vault) {
                return i;
            }
        }
        revert("Vault not found");
    }

    // === FHE Public CID ===

    function getFhePublicCID() external view returns (string memory) {
        return fhePublicCID;
    }

    function updateFhePublicCID(string calldata newCID) external onlyOwner {
        fhePublicCID = newCID;
        emit PublicCIDUpdated(newCID);
    }

    // === Ownership ===
    
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}
