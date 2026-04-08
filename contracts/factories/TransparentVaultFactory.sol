// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "../interfaces/IOrionConfig.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title TransparentVaultFactory
 * @notice A factory contract for creating Orion transparent vaults using Beacon Proxy pattern
 * @author Orion Finance
 * @dev This contract deploys BeaconProxy instances that point to a shared transparent vault implementation.
 * @custom:security-contact security@orionfinance.ai
 */
contract TransparentVaultFactory is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
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
        if (initialOwner == address(0)) revert ErrorsLib.ZeroAddress();
        if (configAddress == address(0) || vaultBeaconAddress == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        config = IOrionConfig(configAddress);
        vaultBeacon = UpgradeableBeacon(vaultBeaconAddress);
    }

    /// @notice Creates a new transparent vault
    /// @param strategist The address of the vault strategist
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    /// @param depositAccessControl The address of the deposit access control contract (address(0) = permissionless)
    /// @return vault The address of the new transparent vault
    function createVault(
        address strategist,
        string calldata name,
        string calldata symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee,
        address depositAccessControl
    ) external returns (address vault) {
        address manager = msg.sender;

        if (bytes(name).length > 26) revert ErrorsLib.InvalidArguments();
        if (bytes(symbol).length > 4) revert ErrorsLib.InvalidArguments();

        if (!config.isWhitelistedManager(manager)) revert ErrorsLib.NotAuthorized();
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        // Encode the initialization call
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

        // Deploy BeaconProxy pointing to the vault beacon
        BeaconProxy proxy = new BeaconProxy(address(vaultBeacon), initData);
        vault = address(proxy);

        config.addOrionVault(vault, EventsLib.VaultType.Transparent);
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
            EventsLib.VaultType.Transparent
        );
    }

    /// @notice Updates the vault beacon address
    /// @param newVaultBeacon The new UpgradeableBeacon address
    function setVaultBeacon(address newVaultBeacon) external onlyOwner {
        if (newVaultBeacon == address(0)) revert ErrorsLib.ZeroAddress();
        vaultBeacon = UpgradeableBeacon(newVaultBeacon);
        emit EventsLib.VaultBeaconUpdated(newVaultBeacon);
    }

    /// @notice Address of the upgrade timelock that must authorise all implementation upgrades
    address public upgradeTimelock;

    /// @notice Sets the upgrade timelock address.
    /// @dev If no timelock is set yet, only the owner may call this. Once a timelock is active,
    ///      only the timelock itself may replace it, preventing the owner from bypassing the delay.
    /// @param newTimelock The new timelock address (e.g. OpenZeppelin TimelockController); address(0) not permitted
    function setUpgradeTimelock(address newTimelock) external {
        if (upgradeTimelock == address(0)) {
            if (msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        } else {
            if (msg.sender != upgradeTimelock) revert ErrorsLib.NotAuthorized();
        }
        if (newTimelock == address(0)) revert ErrorsLib.ZeroAddress();
        upgradeTimelock = newTimelock;
        emit EventsLib.UpgradeTimelockSet(address(this), newTimelock);
    }

    /// @notice Authorizes an upgrade to a new implementation
    /// @dev Requires the caller to be the upgrade timelock (if set) or the owner (during initial
    ///      bootstrapping before a timelock has been configured).
    // solhint-disable-next-line use-natspec
    function _authorizeUpgrade(address) internal override {
        if (upgradeTimelock != address(0)) {
            if (msg.sender != upgradeTimelock) revert ErrorsLib.NotAuthorized();
        } else {
            if (msg.sender != owner()) revert ErrorsLib.NotAuthorized();
        }
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
