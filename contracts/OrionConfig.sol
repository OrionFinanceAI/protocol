// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.4;

import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

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
contract OrionConfig is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IOrionConfig {
    // Protocol-wide configuration
    IERC20 public underlyingAsset;
    address public internalStatesOrchestrator;
    address public liquidityOrchestrator;
    address public vaultFactory;
    address public oracleRegistry;

    // Curator-specific configuration
    uint8 public curatorIntentDecimals;

    // Vault-specific configuration
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;

    // Orion-specific configuration
    EnumerableSet.AddressSet private orionVaults;

    modifier onlyFactory() {
        if (msg.sender != vaultFactory) revert ErrorsLib.NotFactory();
        _;
    }

    function initialize(address initialOwner) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(initialOwner);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // === Protocol Configuration ===

    function setProtocolParams(
        address _underlyingAsset,
        address _internalStatesOrchestrator,
        address _liquidityOrchestrator,
        uint8 _curatorIntentDecimals,
        address _factory,
        address _oracleRegistry
    ) external onlyOwner {
        if (_underlyingAsset == address(0)) revert ErrorsLib.InvalidAsset();
        if (_internalStatesOrchestrator == address(0)) revert ErrorsLib.InvalidInternalOrchestrator();
        if (_liquidityOrchestrator == address(0)) revert ErrorsLib.InvalidLiquidityOrchestrator();
        if (_factory == address(0)) revert ErrorsLib.ZeroAddress();
        if (_oracleRegistry == address(0)) revert ErrorsLib.ZeroAddress();

        underlyingAsset = IERC20(_underlyingAsset);
        internalStatesOrchestrator = _internalStatesOrchestrator;
        liquidityOrchestrator = _liquidityOrchestrator;
        curatorIntentDecimals = _curatorIntentDecimals;
        vaultFactory = _factory;
        oracleRegistry = _oracleRegistry;

        emit EventsLib.ProtocolParamsUpdated(
            _underlyingAsset,
            _internalStatesOrchestrator,
            _liquidityOrchestrator,
            _curatorIntentDecimals,
            _factory,
            _oracleRegistry
        );
    }

    // === Whitelist Functions ===

    function addWhitelistedAsset(address asset) external onlyOwner {
        bool inserted = whitelistedAssets.add(asset);
        if (!inserted) revert ErrorsLib.AlreadyWhitelisted();
        emit EventsLib.WhitelistedAssetAdded(asset);
    }

    function removeWhitelistedAsset(address asset) external onlyOwner {
        bool removed = whitelistedAssets.remove(asset);
        if (!removed) revert ErrorsLib.NotInWhitelist();
        emit EventsLib.WhitelistedAssetRemoved(asset);
    }

    function whitelistedAssetsLength() external view returns (uint256) {
        return whitelistedAssets.length();
    }

    function getWhitelistedAssetAt(uint256 index) external view returns (address) {
        return whitelistedAssets.at(index);
    }

    function getAllWhitelistedAssets() external view returns (address[] memory assets) {
        uint256 length = whitelistedAssets.length();
        assets = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            assets[i] = whitelistedAssets.at(i);
        }
        return assets;
    }

    function isWhitelisted(address asset) external view returns (bool) {
        return whitelistedAssets.contains(asset);
    }

    // === Orion Vaults ===

    function addOrionVault(address vault) external onlyFactory {
        bool inserted = orionVaults.add(vault);
        if (!inserted) revert ErrorsLib.AlreadyAnOrionVault();
        emit EventsLib.OrionVaultAdded(vault);
    }

    function removeOrionVault(address vault) external onlyFactory {
        bool removed = orionVaults.remove(vault);
        if (!removed) revert ErrorsLib.NotAnOrionVault();
        emit EventsLib.OrionVaultRemoved(vault);
    }

    function getAllOrionVaults() external view returns (address[] memory) {
        uint256 length = orionVaults.length();
        address[] memory vaults = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            vaults[i] = orionVaults.at(i);
        }
        return vaults;
    }

    function getVaultStates()
        external
        view
        returns (
            address[] memory vaults,
            uint256[] memory sharePrices,
            uint256[] memory totalAssets,
            uint256[] memory depositRequests,
            uint256[] memory withdrawRequests
        )
    {
        uint256 length = orionVaults.length();
        vaults = new address[](length);
        sharePrices = new uint256[](length);
        totalAssets = new uint256[](length);
        depositRequests = new uint256[](length);
        withdrawRequests = new uint256[](length);

        for (uint256 i = 0; i < length; ++i) {
            address vaultAddress = orionVaults.at(i);
            vaults[i] = vaultAddress;

            IOrionVault vault = IOrionVault(vaultAddress);
            sharePrices[i] = vault.sharePrice();
            totalAssets[i] = vault.totalAssets();

            // Get pending deposits and withdrawals
            depositRequests[i] = vault.getPendingDeposits();
            withdrawRequests[i] = vault.getPendingWithdrawals();
        }
    }
}
