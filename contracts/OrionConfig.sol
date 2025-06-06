// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OrionConfig {
    address public owner;

    // Protocol-wide configuration
    address public underlyingAsset;
    address public internalStateOrchestrator;
    address public liquidityOrchestrator;
    address public priceAndPnLOracle;
    address public vaultFactory;

    string public fhePublicCID;

    address[] public whitelistedVaults;
    mapping(address => bool) public isWhitelisted;

    address[] public orionVaults;
    mapping(address => bool) public isOrionVault;
    
    uint256 public whitelistVaultCount;
    uint256 public orionVaultCount;

    // Events
    event WhitelistedVaultAdded(address indexed vault);
    event WhitelistedVaultRemoved(address indexed vault);
    event OrionVaultAdded(address indexed vault);
    event OrionVaultRemoved(address indexed vault);
    event VaultFactorySet(address factory);
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

    modifier onlyFactory() {
        require(msg.sender == vaultFactory, "Not factory");
        _;
    }

    // Constructor
    constructor() {
        owner = msg.sender;
    }

    // === Protocol Configuration ===

    function setVaultFactory(address _factory) external onlyOwner {
        require(_factory != address(0), "Zero address");
        require(vaultFactory == address(0), "Factory already set");
        vaultFactory = _factory;
        emit VaultFactorySet(_factory);
    }

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

    function addWhitelistedVault(address vault) external onlyOwner {
        require(!isWhitelisted[vault], "Already whitelisted");
        whitelistedVaults.push(vault);
        isWhitelisted[vault] = true;
        whitelistVaultCount += 1;
        emit WhitelistedVaultAdded(vault);
    }

    function removeWhitelistedVault(address vault) external onlyOwner {
        require(isWhitelisted[vault], "Not in list of whitelistedVaults");

        uint256 index = _indexOfWhitelistedVault(vault);
        // Swap and pop
        whitelistedVaults[index] = whitelistedVaults[whitelistedVaults.length - 1];
        whitelistedVaults.pop();
    
        isWhitelisted[vault] = false;
        whitelistVaultCount -= 1;

        emit WhitelistedVaultRemoved(vault);
    }

    function getWhitelistedVaultAt(uint256 index) external view returns (address) {
        require(index < whitelistedVaults.length, "Index out of bounds");
        return whitelistedVaults[index];
    }

    function _indexOfWhitelistedVault(address vault) internal view returns (uint256) {
        for (uint i = 0; i < whitelistedVaults.length; i++) {
            if (whitelistedVaults[i] == vault) {
                return i;
            }
        }
        revert("Vault not found in list of whitelistedVaults");
    }

    // === Orion Vaults ===

    function addOrionVault(address vault) external onlyFactory {
        require(!isOrionVault[vault], "Already an OrionVault");
        orionVaults.push(vault);
        isOrionVault[vault] = true;
        orionVaultCount += 1;
        emit OrionVaultAdded(vault);
    }

    function removeOrionVault(address vault) external onlyFactory {
        require(isOrionVault[vault], "Not an OrionVault");

        uint256 index = _indexOfOrionVault(vault);
        orionVaults[index] = orionVaults[orionVaults.length - 1];
        orionVaults.pop();

        isOrionVault[vault] = false;
        orionVaultCount -= 1;

        emit OrionVaultRemoved(vault);
    }

    function getOrionVaultAt(uint256 index) external view returns (address) {
        require(index < orionVaults.length, "Index out of bounds");
        return orionVaults[index];
    }

    function _indexOfOrionVault(address vault) internal view returns (uint256) {
        for (uint i = 0; i < orionVaults.length; i++) {
            if (orionVaults[i] == vault) {
                return i;
            }
        }
        revert("OrionVault not found in list of OrionVaults");
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
