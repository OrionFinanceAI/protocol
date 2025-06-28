// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.4;

import "./interfaces/IOrionConfig.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IMarketOracle.sol";

/**
 *     ██████╗ ██████╗ ██╗ ██████╗ ███╗   ██╗    ███████╗██╗███╗   ██╗ █████╗ ███╗   ██╗ ██████╗███████╗
 *    ██╔═══██╗██╔══██╗██║██╔═══██╗████╗  ██║    ██╔════╝██║████╗  ██║██╔══██╗████╗  ██║██╔════╝██╔════╝
 *    ██║   ██║██████╔╝██║██║   ██║██╔██╗ ██║    █████╗  ██║██╔██╗ ██║███████║██╔██╗ ██║██║     █████╗
 *    ██║   ██║██╔══██╗██║██║   ██║██║╚██╗██║    ██╔══╝  ██║██║╚██╗██║██╔══██║██║╚██╗██║██║     ██╔══╝
 *    ╚██████╔╝██║  ██║██║╚██████╔╝██║ ╚████║    ██║     ██║██║ ╚████║██║  ██║██║ ╚████║╚██████╗███████╗
 *     ╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝╚══════╝
 *
 * @title OrionConfig
 * @notice This contract is responsible for configuring the Orion protocol.
 */
contract OrionConfig is IOrionConfig, Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    // Protocol-wide configuration
    IERC20 public underlyingAsset;
    address public internalStatesOrchestrator;
    address public liquidityOrchestrator;
    IMarketOracle public marketOracle;
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
    event PublicCIDUpdated(string newCID);
    event ProtocolParamsUpdated(
        address underlyingAsset,
        address internalStatesOrchestrator,
        address liquidityOrchestrator,
        IMarketOracle marketOracle,
        uint256 curatorIntentDecimals,
        string fhePublicCID,
        address factory
    );

    modifier onlyFactory() {
        if (msg.sender != vaultFactory) revert ErrorsLib.NotFactory();
        _;
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // === Protocol Configuration ===

    function setProtocolParams(
        address _underlyingAsset,
        address _internalStatesOrchestrator,
        address _liquidityOrchestrator,
        IMarketOracle _marketOracle,
        uint8 _curatorIntentDecimals,
        string calldata _fhePublicCID,
        address _factory
    ) external onlyOwner {
        if (_underlyingAsset == address(0)) revert ErrorsLib.InvalidAsset();
        if (_internalStatesOrchestrator == address(0)) revert ErrorsLib.InvalidInternalOrchestrator();
        if (_liquidityOrchestrator == address(0)) revert ErrorsLib.InvalidLiquidityOrchestrator();
        if (address(_marketOracle) == address(0)) revert ErrorsLib.InvalidMarketOracle();
        if (_factory == address(0)) revert ErrorsLib.ZeroAddress();

        underlyingAsset = IERC20(_underlyingAsset);
        internalStatesOrchestrator = _internalStatesOrchestrator;
        liquidityOrchestrator = _liquidityOrchestrator;
        marketOracle = _marketOracle;
        curatorIntentDecimals = _curatorIntentDecimals;
        fhePublicCID = _fhePublicCID;
        vaultFactory = _factory;

        emit ProtocolParamsUpdated(
            _underlyingAsset,
            _internalStatesOrchestrator,
            _liquidityOrchestrator,
            _marketOracle,
            _curatorIntentDecimals,
            _fhePublicCID,
            _factory
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

    function updateFhePublicCID(string calldata newCID) external onlyOwner {
        fhePublicCID = newCID;
        emit PublicCIDUpdated(newCID);
    }
}
