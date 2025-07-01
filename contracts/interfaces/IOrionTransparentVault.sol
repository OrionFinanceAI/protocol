// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./IOrionVault.sol";

interface IOrionTransparentVault is IOrionVault {
    struct Position {
        address token;
        uint32 weight;
    }

    /// @notice Submit a plaintext portfolio intent.
    /// @param order Position struct containing the tokens and plaintext weights.
    function submitOrderIntent(Position[] calldata order) external;

    // Internal States Orchestrator Functions
    function getPortfolio() external view returns (address[] memory tokens, uint256[] memory weights);
}
