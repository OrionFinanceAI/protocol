// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "../interfaces/IOrionConfig.sol";
import "../vaults/OrionTransparentVaultUpgradeable.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title TransparentVaultFactoryUpgradeable
 * @notice A factory contract for creating Orion transparent vaults using Beacon Proxy pattern
 * @author Orion Finance
 * @dev This contract deploys BeaconProxy instances that point to a shared vault implementation.
 */
contract TransparentVaultFactoryUpgradeable is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice UpgradeableBeacon for transparent vaults
    UpgradeableBeacon public vaultBeacon;

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param initialOwner The address of the initial owner
    /// @param configAddress The address of the OrionConfig contract
    /// @param vaultBeaconAddress The address of the UpgradeableBeacon for vaults
    function initialize(address initialOwner, address configAddress, address vaultBeaconAddress) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();

        if (configAddress == address(0) || vaultBeaconAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        vaultBeacon = UpgradeableBeacon(vaultBeaconAddress);
    }

    /// @notice Creates a new transparent vault using BeaconProxy pattern
    /// @param curator The address of the vault curator
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @param depositAccessControl The address of the deposit access control contract (address(0) = permissionless)
    /// @return vault The address of the new transparent vault
    function createVault(
        address curator,
        string calldata name,
        string calldata symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee,
        address depositAccessControl
    ) external returns (address vault) {
        address vaultOwner = msg.sender;

        if (!config.isWhitelistedVaultOwner(vaultOwner)) revert ErrorsLib.NotAuthorized();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Encode the initialization call
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,string,string,uint8,uint16,uint16,address)",
            vaultOwner,
            curator,
            address(config),
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee,
            depositAccessControl
        );

        // Deploy BeaconProxy pointing to the vault beacon
        BeaconProxy proxy = new BeaconProxy(address(vaultBeacon), initData);
        vault = address(proxy);

        config.addOrionVault(vault, EventsLib.VaultType.Transparent);
        emit EventsLib.OrionVaultCreated(
            vault,
            vaultOwner,
            curator,
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee,
            depositAccessControl,
            EventsLib.VaultType.Transparent
        );
    }

    /// @notice Updates the vault beacon address
    /// @param newVaultBeacon The new UpgradeableBeacon address
    function setVaultBeacon(address newVaultBeacon) external onlyOwner {
        if (newVaultBeacon == address(0)) revert ErrorsLib.ZeroAddress();
        vaultBeacon = UpgradeableBeacon(newVaultBeacon);
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /**
     * @dev Storage gap to allow for future upgrades
     * Total storage slots reserved: 49 (50 - 1 for vaultBeacon)
     */
    uint256[49] private __gap;
}
