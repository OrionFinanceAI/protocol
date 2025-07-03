// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionVault.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
    uint8 public statesDecimals;

    // Curator-specific configuration
    uint8 public curatorIntentDecimals;

    // Vault-specific configuration
    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private whitelistedAssets;

    // Orion-specific configuration
    EnumerableSet.AddressSet private orionTransparentVaults;
    EnumerableSet.AddressSet private orionEncryptedVaults;

    modifier onlyFactory() {
        if (msg.sender != vaultFactory) revert ErrorsLib.NotFactory();
        _;
    }

    function initialize(address initialOwner) public initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(initialOwner);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    // === Protocol Configuration ===

    function setProtocolParams(
        address underlyingAsset_,
        address internalStatesOrchestrator_,
        address liquidityOrchestrator_,
        uint8 statesDecimals_,
        uint8 curatorIntentDecimals_,
        address factory_,
        address oracleRegistry_
    ) external onlyOwner {
        if (underlyingAsset_ == address(0)) revert ErrorsLib.InvalidAsset();
        if (internalStatesOrchestrator_ == address(0)) revert ErrorsLib.InvalidInternalOrchestrator();
        if (liquidityOrchestrator_ == address(0)) revert ErrorsLib.InvalidLiquidityOrchestrator();
        if (factory_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (oracleRegistry_ == address(0)) revert ErrorsLib.ZeroAddress();

        underlyingAsset = IERC20(underlyingAsset_);
        internalStatesOrchestrator = internalStatesOrchestrator_;
        liquidityOrchestrator = liquidityOrchestrator_;

        uint8 underlyingDecimals = IERC20Metadata(underlyingAsset_).decimals();
        if (statesDecimals_ < underlyingDecimals) revert ErrorsLib.InvalidStatesDecimals();
        statesDecimals = statesDecimals_;

        curatorIntentDecimals = curatorIntentDecimals_;
        vaultFactory = factory_;
        oracleRegistry = oracleRegistry_;

        emit EventsLib.ProtocolParamsUpdated(
            underlyingAsset_,
            internalStatesOrchestrator_,
            liquidityOrchestrator_,
            statesDecimals_,
            curatorIntentDecimals_,
            factory_,
            oracleRegistry_
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

    function addOrionVault(address vault, EventsLib.VaultType vaultType) external onlyFactory {
        // NOTE: could check the type of the vault with EIP-165, instead of only
        // checking it's not a zero address.
        // https://eips.ethereum.org/EIPS/eip-165
        if (vault == address(0)) revert ErrorsLib.ZeroAddress();

        bool inserted;
        if (vaultType == EventsLib.VaultType.Encrypted) {
            inserted = orionEncryptedVaults.add(vault);
        } else {
            inserted = orionTransparentVaults.add(vault);
        }

        if (!inserted) revert ErrorsLib.AlreadyAnOrionVault();
        emit EventsLib.OrionVaultAdded(vault);
    }

    function removeOrionVault(address vault, EventsLib.VaultType vaultType) external onlyFactory {
        bool removed;
        if (vaultType == EventsLib.VaultType.Encrypted) {
            removed = orionEncryptedVaults.remove(vault);
        } else {
            removed = orionTransparentVaults.remove(vault);
        }

        if (!removed) revert ErrorsLib.NotAnOrionVault();
        emit EventsLib.OrionVaultRemoved(vault);
    }

    function getAllOrionVaults(EventsLib.VaultType vaultType) external view returns (address[] memory) {
        EnumerableSet.AddressSet storage vaults = vaultType == EventsLib.VaultType.Encrypted
            ? orionEncryptedVaults
            : orionTransparentVaults;
        uint256 length = vaults.length();
        address[] memory vaultArray = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            vaultArray[i] = vaults.at(i);
        }
        return vaultArray;
    }
}
