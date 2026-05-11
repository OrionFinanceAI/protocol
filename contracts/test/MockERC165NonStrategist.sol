// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/// @dev ERC-165 compliant contract that is NOT an IOrionStrategist.
///      Simulates a SAFE multisig or other smart-contract wallet:
///      supportsInterface returns true only for IERC165 itself.
contract MockERC165NonStrategist is ERC165 {}
