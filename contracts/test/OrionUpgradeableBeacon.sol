// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

contract OrionUpgradeableBeacon is UpgradeableBeacon {
    constructor(address implementation, address initialOwner) UpgradeableBeacon(implementation, initialOwner) {}
}
