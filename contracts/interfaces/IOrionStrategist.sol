// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IOrionStrategist
/// @notice Interface for smart contract strategists that compute portfolio intents on-demand.
/// @author Orion Finance
/// @dev Implementors must support ERC-165 so that vaults can detect and auto-link them on assignment.
/// @custom:security-contact security@orionfinance.ai
interface IOrionStrategist is IERC165 {
    /// @notice Link this strategist to a vault. Can only be called once per deployment.
    /// @param vault_ The vault address to link to this strategist.
    function setVault(address vault_) external;

    /// @notice Compute the current portfolio intent from on-chain state and submit it to the linked vault.
    function submitIntent() external;
}
