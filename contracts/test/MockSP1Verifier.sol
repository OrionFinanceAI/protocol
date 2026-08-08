// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

/**
 * @title MockSP1Verifier
 * @notice Always-succeeding SP1 verifier for unit tests that exercise performUpkeep payloads
 */
contract MockSP1Verifier is ISP1Verifier {
    /// @inheritdoc ISP1Verifier
    // solhint-disable-next-line no-empty-blocks
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}
