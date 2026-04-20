// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Imported so Hardhat compiles the OZ TimelockController artifact, making it available
// for getContractFactory("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController")
// in test suites without requiring a custom wrapper contract.
// solhint-disable-next-line no-unused-import
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
