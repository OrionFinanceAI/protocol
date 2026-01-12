// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IOrionConfig.sol";

/// @title IInternalStateOrchestrator
/// @notice Interface for the internal state orchestrator
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
interface IInternalStateOrchestrator is AutomationCompatibleInterface {
    /// @notice Upkeep phase
    enum InternalUpkeepPhase {
        Idle,
        PreprocessingTransparentVaults,
        Buffering,
        PostprocessingTransparentVaults,
        BuildingOrders
    }

    /// @notice Returns the epoch duration
    /// @return The epoch duration in seconds
    function epochDuration() external view returns (uint32);

    /// @notice Updates the next update time
    /// @dev Can only be called by the Liquidity Orchestrator
    function updateNextUpdateTime() external;

    /// @notice Returns the current upkeep phase
    /// @return The current InternalUpkeepPhase
    function currentPhase() external view returns (InternalUpkeepPhase);

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Updates the epoch duration
    /// @param newEpochDuration The new epoch duration in seconds
    function updateEpochDuration(uint32 newEpochDuration) external;

    /// @notice Updates the minibatch sizes
    /// @param _transparentMinibatchSize The new transparent minibatch size
    function updateMinibatchSize(uint8 _transparentMinibatchSize) external;

    /// @notice Updates the protocol fees
    /// @param _vFeeCoefficient The new volume fee coefficient
    /// @param _rsFeeCoefficient The new revenue share fee coefficient
    function updateProtocolFees(uint16 _vFeeCoefficient, uint16 _rsFeeCoefficient) external;

    /// @notice Returns the pending protocol fees
    /// @return The pending protocol fees
    function pendingProtocolFees() external view returns (uint256);

    /// @notice Returns the current buffer amount
    /// @return The current buffer amount
    function bufferAmount() external view returns (uint256);

    /// @notice Subtracts a specified amount from the pending protocol fees
    /// @param amount The amount to subtract from pending protocol fees
    function subtractPendingProtocolFees(uint256 amount) external;

    /// @notice Get orders for a specific leg
    /// @param isSellLeg True if getting sell leg orders, false if getting buy leg orders
    /// @return tokens The tokens for the specified leg
    /// @return amounts The amounts for the specified leg in shares
    /// @return estimatedUnderlyingAmounts The estimated underlying amounts for the specified leg
    function getOrders(
        bool isSellLeg
    )
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts, uint256[] memory estimatedUnderlyingAmounts);

    /// @notice Get price for a specific token
    /// @param token The token to get the price of
    /// @return price The corresponding price [shares/assets]
    function getPriceOf(address token) external view returns (uint256 price);

    /// @notice Updates the buffer amount based on execution vs estimated amounts
    /// @param deltaAmount The amount to add/subtract from the buffer (can be negative)
    /// @dev Can only be called by the Liquidity Orchestrator
    function updateBufferAmount(int256 deltaAmount) external;

    /// @notice Get all vault total assets values
    /// @param vault The vault address
    /// @return totalAssetsForRedeem The total assets for fulfill redeem
    /// @return totalAssetsForDeposit The total assets for fulfill deposit
    /// @return totalAssets The final total assets for state update
    function getVaultTotalAssetsAll(
        address vault
    ) external view returns (uint256 totalAssetsForRedeem, uint256 totalAssetsForDeposit, uint256 totalAssets);

    /// @notice Get the list of tokens for the current epoch
    /// @return tokens The array of token addresses used in the current epoch
    /// @dev This function blocks if the internal state orchestrator is not idle
    function getEpochTokens() external view returns (address[] memory tokens);

    /// @notice Get portfolio shares for a specific vault
    /// @param vault The vault address
    /// @return tokens The array of token addresses in the vault's portfolio
    /// @return shares The array of portfolio shares for each token [shares]
    function getVaultPortfolio(address vault) external view returns (address[] memory tokens, uint256[] memory shares);

    /// @notice Get the vault fee for a specific vault
    /// @param vault The vault address
    /// @return The vault fee amount [assets]
    function getVaultFee(address vault) external view returns (uint256);

    /// @notice Pauses the contract
    /// @dev Can only be called by OrionConfig for emergency situations
    function pause() external;

    /// @notice Unpauses the contract
    /// @dev Can only be called by OrionConfig after resolving emergency
    function unpause() external;
}
