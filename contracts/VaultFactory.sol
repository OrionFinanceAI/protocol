// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "./interfaces/IOrionConfig.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

/**
 * @title VaultFactory
 * @notice Unified factory for creating Orion vaults using the Beacon Proxy pattern
 * @author Orion Finance
 * @dev Deploys BeaconProxy instances; the vault type is selected via createVault(..., vaultType).
 *      Configure both beacons at init or via setTransparentVaultBeacon / setEncryptedVaultBeacon.
 * @custom:security-contact security@orionfinance.ai
 */
contract VaultFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// @notice Orion Config contract address
    IOrionConfig public config;

    /// @notice UpgradeableBeacon for transparent vaults
    UpgradeableBeacon public transparentVaultBeacon;
    /// @notice UpgradeableBeacon for encrypted vaults
    UpgradeableBeacon public encryptedVaultBeacon;

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract
    /// @param initialOwner The address of the initial owner
    /// @param configAddress The address of the OrionConfig contract
    /// @param transparentBeaconAddress The address of the UpgradeableBeacon for transparent vaults
    /// @param encryptedBeaconAddress The address of the UpgradeableBeacon for encrypted vaults
    function initialize(
        address initialOwner,
        address configAddress,
        address transparentBeaconAddress,
        address encryptedBeaconAddress
    ) public initializer {
        if (initialOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (transparentBeaconAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (encryptedBeaconAddress == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        config = IOrionConfig(configAddress);
        transparentVaultBeacon = UpgradeableBeacon(transparentBeaconAddress);
        encryptedVaultBeacon = UpgradeableBeacon(encryptedBeaconAddress);
    }

    /// @notice Creates a new vault
    /// @param strategist The address of the vault strategist
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @param depositAccessControl The address of the deposit access control contract (address(0) = permissionless)
    /// @param vaultType Whether to deploy a Transparent or Encrypted vault
    /// @return vault The address of the new vault
    function createVault(
        address strategist,
        string calldata name,
        string calldata symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee,
        address depositAccessControl,
        EventsLib.VaultType vaultType
    ) external returns (address vault) {
        address manager = msg.sender;

        if (bytes(name).length > 26) revert ErrorsLib.InvalidArguments();
        if (bytes(symbol).length > 4) revert ErrorsLib.InvalidArguments();
        if (!config.isWhitelistedManager(manager)) revert ErrorsLib.NotAuthorized();
        if (strategist == address(0)) revert ErrorsLib.ZeroAddress();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        UpgradeableBeacon beacon = vaultType == EventsLib.VaultType.Transparent
            ? transparentVaultBeacon
            : encryptedVaultBeacon;

        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,address,string,string,uint8,uint16,uint16,address)",
            manager,
            strategist,
            address(config),
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee,
            depositAccessControl
        );

        BeaconProxy proxy = new BeaconProxy(address(beacon), initData);
        vault = address(proxy);

        config.addOrionVault(vault, vaultType);
        emit EventsLib.OrionVaultCreated(
            vault,
            manager,
            strategist,
            name,
            symbol,
            feeType,
            performanceFee,
            managementFee,
            depositAccessControl,
            vaultType
        );
    }

    /// @notice Updates the transparent vault beacon address
    /// @param newBeacon The new UpgradeableBeacon address for transparent vaults
    function setTransparentVaultBeacon(address newBeacon) external onlyOwner {
        if (newBeacon == address(0)) revert ErrorsLib.ZeroAddress();
        transparentVaultBeacon = UpgradeableBeacon(newBeacon);
        emit EventsLib.VaultBeaconUpdated(newBeacon);
    }

    /// @notice Updates the encrypted vault beacon address
    /// @param newBeacon The new UpgradeableBeacon address for encrypted vaults
    function setEncryptedVaultBeacon(address newBeacon) external onlyOwner {
        if (newBeacon == address(0)) revert ErrorsLib.ZeroAddress();
        encryptedVaultBeacon = UpgradeableBeacon(newBeacon);
        emit EventsLib.VaultBeaconUpdated(newBeacon);
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev This function is required by UUPS and can only be called by the owner
    /// @param newImplementation The address of the new implementation contract
    // solhint-disable-next-line no-empty-blocks, use-natspec
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
