// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.4;

import "./interfaces/IOrionConfig.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

contract OrionConfig is IOrionConfig, Ownable2Step {
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
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;

    // Orion-specific configuration
    EnumerableSet.AddressSet private orionVaults;

    // Events
    event WhitelistedAssetAdded(address indexed asset);
    event WhitelistedAssetRemoved(address indexed asset);
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

    modifier onlyFactory() {
        if (msg.sender != vaultFactory) revert ErrorsLib.NotFactory();
        _;
    }

    // Constructor
    constructor() Ownable(msg.sender) {}

    // === Protocol Configuration ===

    function setVaultFactory(address _factory) external onlyOwner {
        if (_factory == address(0)) revert ErrorsLib.ZeroAddress();
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
        if (_underlyingAsset == address(0)) revert ErrorsLib.InvalidAsset();
        if (_internalStatesOrchestrator == address(0)) revert ErrorsLib.InvalidInternalOrchestrator();
        if (_liquidityOrchestrator == address(0)) revert ErrorsLib.InvalidLiquidityOrchestrator();
        if (_priceAndPnLOracle == address(0)) revert ErrorsLib.InvalidPriceAndPnLOracle();

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

    function addWhitelistedAsset(address asset) external onlyOwner {
        bool inserted = whitelistedAssets.add(asset);
        if (!inserted) revert ErrorsLib.AlreadyWhitelisted();
        emit WhitelistedAssetAdded(asset);
    }

    function removeWhitelistedAsset(address asset) external onlyOwner {
        bool removed = whitelistedAssets.remove(asset);
        if (!removed) revert ErrorsLib.NotInWhitelist();
        emit WhitelistedAssetRemoved(asset);
    }

    function whitelistedAssetsLength() external view returns (uint256) {
        return whitelistedAssets.length();
    }

    function getWhitelistedAssetAt(uint256 index) external view returns (address) {
        return whitelistedAssets.at(index);
    }

    function isWhitelisted(address asset) external view returns (bool) {
        return whitelistedAssets.contains(asset);
    }

    // === Orion Vaults ===

    function addOrionVault(address vault) external onlyFactory {
        bool inserted = orionVaults.add(vault);
        if (!inserted) revert ErrorsLib.AlreadyAnOrionVault();
        emit OrionVaultAdded(vault);
    }

    function removeOrionVault(address vault) external onlyFactory {
        bool removed = orionVaults.remove(vault);
        if (!removed) revert ErrorsLib.NotAnOrionVault();
        emit OrionVaultRemoved(vault);
    }

    function orionVaultsLength() external view returns (uint256) {
        return orionVaults.length();
    }

    function getOrionVaultAt(uint256 index) external view returns (address) {
        return orionVaults.at(index);
    }

    // === FHE Public CID ===

    function getFhePublicCID() external view returns (string memory) {
        return fhePublicCID;
    }

    function updateFhePublicCID(string calldata newCID) external onlyOwner {
        fhePublicCID = newCID;
        emit PublicCIDUpdated(newCID);
    }
}
