// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IOrionConfig.sol";

/// @title IInternalStateOrchestrator
/// @notice Interface for the internal state orchestrator
/// @author Orion Finance
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

    /// @notice Returns the current upkeep phase
    /// @return The current InternalUpkeepPhase
    function currentPhase() external view returns (InternalUpkeepPhase);

    /// @notice Returns the current epoch counter
    /// @return The current epoch
    function epochCounter() external view returns (uint16);

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

    /// @notice Get selling and buying orders
    /// @return sellingTokens The tokens to sell
    /// @return sellingAmounts The amounts to sell in shares
    /// @return buyingTokens The tokens to buy
    /// @return buyingAmounts The amounts to buy in underlying assets
    /// @return sellingEstimatedUnderlyingAmounts The estimated underlying amounts to sell
    /// @return buyingEstimatedUnderlyingAmounts The estimated underlying amounts to buy
    function getOrders()
        external
        view
        returns (
            address[] memory sellingTokens,
            uint256[] memory sellingAmounts,
            address[] memory buyingTokens,
            uint256[] memory buyingAmounts,
            uint256[] memory sellingEstimatedUnderlyingAmounts,
            uint256[] memory buyingEstimatedUnderlyingAmounts
        );

    /// @notice Get price for a specific token
    /// @param token The token to get the price of
    /// @return price The corresponding price [shares/assets]
    function getPriceOf(address token) external view returns (uint256 price);

    /// @notice Updates the buffer amount based on execution vs estimated amounts
    /// @param deltaAmount The amount to add/subtract from the buffer (can be negative)
    /// @dev Can only be called by the Liquidity Orchestrator
    function updateBufferAmount(int256 deltaAmount) external;

    /// @notice Get total assets for fulfill redeem for a specific vault
    /// @param vault The vault address
    /// @return totalAssets The total assets for fulfill redeem
    function getVaultTotalAssetsForFulfillRedeem(address vault) external view returns (uint256 totalAssets);

    /// @notice Get total assets for fulfill deposit for a specific vault
    /// @param vault The vault address
    /// @return totalAssets The total assets for fulfill deposit
    function getVaultTotalAssetsForFulfillDeposit(address vault) external view returns (uint256 totalAssets);

    /// @notice Get the list of tokens for the current epoch
    /// @return tokens The array of token addresses used in the current epoch
    /// @dev This function blocks if the internal state orchestrator is not idle
    function getEpochTokens() external view returns (address[] memory tokens);
}
