// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

contract OrionConfig {
    address public owner;

    // Protocol-wide configuration
    address public underlyingAsset;
    address public internalStatesOrchestrator;
    address public liquidityOrchestrator;
    address public priceAndPnLOracle;
    address public vaultFactory;

    // Curator-specific configuration
    uint8 public curatorIntentDecimals;
    string public fhePublicCID;

    // Vault-specific configuration
    address[] public whitelistedVaults;
    mapping(address => uint256) public whitelistedVaultIndex;
    mapping(address => bool) public isWhitelisted;
    uint256 public whitelistVaultCount;

    // Orion-specific configuration
    address[] public orionVaults;
    mapping(address => bool) public isOrionVault;
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
        address internalStatesOrchestrator,
        address liquidityOrchestrator,
        address priceAndPnLOracle,
        uint256 curatorIntentDecimals,
        string fhePublicCID
    );

    error NotOwner();
    error NotFactory();
    error ZeroAddress();
    error InvalidAsset();
    error InvalidInternalOrchestrator();
    error InvalidLiquidityOrchestrator();
    error InvalidPriceAndPnLOracle();
    error AlreadyWhitelisted();
    error NotInWhitelist();
    error IndexOutOfBounds();
    error VaultNotFound();
    error OrionVaultNotFound();
    error AlreadyAnOrionVault();
    error NotAnOrionVault();

    // Modifier
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != vaultFactory) revert NotFactory();
        _;
    }

    // Constructor
    constructor() {
        owner = msg.sender;
    }

    // === Protocol Configuration ===

    function setVaultFactory(address _factory) external onlyOwner {
        if (_factory == address(0)) revert ZeroAddress();
        vaultFactory = _factory;
        emit VaultFactorySet(_factory);
    }

    function setProtocolParams(
        address _underlyingAsset,
        address _internalStatesOrchestrator,
        address _liquidityOrchestrator,
        address _priceAndPnLOracle,
        uint8 _curatorIntentDecimals,
        string calldata _fhePublicCID
    ) external onlyOwner {
        if (_underlyingAsset == address(0)) revert InvalidAsset();
        if (_internalStatesOrchestrator == address(0)) revert InvalidInternalOrchestrator();
        if (_liquidityOrchestrator == address(0)) revert InvalidLiquidityOrchestrator();
        if (_priceAndPnLOracle == address(0)) revert InvalidPriceAndPnLOracle();

        underlyingAsset = _underlyingAsset;
        internalStatesOrchestrator = _internalStatesOrchestrator;
        liquidityOrchestrator = _liquidityOrchestrator;
        priceAndPnLOracle = _priceAndPnLOracle;
        curatorIntentDecimals = _curatorIntentDecimals;
        fhePublicCID = _fhePublicCID;

        emit ProtocolParamsUpdated(
            _underlyingAsset,
            _internalStatesOrchestrator,
            _liquidityOrchestrator,
            _priceAndPnLOracle,
            _curatorIntentDecimals,
            _fhePublicCID
        );
    }

    // === Whitelist Functions ===

    function addWhitelistedVault(address vault) external onlyOwner {
        if (isWhitelisted[vault]) revert AlreadyWhitelisted();
        whitelistedVaultIndex[vault] = whitelistedVaults.length;
        isWhitelisted[vault] = true;
        whitelistVaultCount += 1;
        whitelistedVaults.push(vault);
        emit WhitelistedVaultAdded(vault);
    }

    function removeWhitelistedVault(address vault) external onlyOwner {
        if (!isWhitelisted[vault]) revert NotInWhitelist();

        uint256 index = _indexOfWhitelistedVault(vault);
        // Swap and pop
        whitelistedVaults[index] = whitelistedVaults[whitelistedVaults.length - 1];
        whitelistedVaults.pop();

        isWhitelisted[vault] = false;
        whitelistVaultCount -= 1;

        emit WhitelistedVaultRemoved(vault);
    }

    function getWhitelistedVaultAt(uint256 index) external view returns (address) {
        if (index >= whitelistedVaults.length) revert IndexOutOfBounds();
        return whitelistedVaults[index];
    }

    function _indexOfWhitelistedVault(address vault) internal view returns (uint256) {
        for (uint256 i = 0; i < whitelistedVaults.length; i++) {
            if (whitelistedVaults[i] == vault) {
                return i;
            }
        }
        revert VaultNotFound();
    }

    // === Orion Vaults ===

    function addOrionVault(address vault) external onlyFactory {
        if (isOrionVault[vault]) revert AlreadyAnOrionVault();
        orionVaults.push(vault);
        isOrionVault[vault] = true;
        orionVaultCount += 1;
        emit OrionVaultAdded(vault);
    }

    function removeOrionVault(address vault) external onlyFactory {
        if (!isOrionVault[vault]) revert NotAnOrionVault();

        uint256 index = _indexOfOrionVault(vault);
        orionVaults[index] = orionVaults[orionVaults.length - 1];
        orionVaults.pop();

        isOrionVault[vault] = false;
        orionVaultCount -= 1;

        emit OrionVaultRemoved(vault);
    }

    function getOrionVaultAt(uint256 index) external view returns (address) {
        if (index >= orionVaults.length) revert IndexOutOfBounds();
        return orionVaults[index];
    }

    function _indexOfOrionVault(address vault) internal view returns (uint256) {
        for (uint256 i = 0; i < orionVaults.length; i++) {
            if (orionVaults[i] == vault) {
                return i;
            }
        }
        revert OrionVaultNotFound();
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
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }
}
