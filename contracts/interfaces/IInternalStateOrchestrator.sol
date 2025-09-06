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
        PreprocessingEncryptedVaults,
        Buffering,
        PostprocessingTransparentVaults,
        PostprocessingEncryptedVaults,
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
    /// @param _encryptedMinibatchSize The new encrypted minibatch size
    function updateMinibatchSizes(uint8 _transparentMinibatchSize, uint8 _encryptedMinibatchSize) external;

    /// @notice Updates the protocol fees
    /// @param _vFeeCoefficient The new volume fee coefficient
    /// @param _rsFeeCoefficient The new revenue share fee coefficient
    function updateProtocolFees(uint16 _vFeeCoefficient, uint16 _rsFeeCoefficient) external;

    /// @notice Returns the pending protocol fees
    /// @return The pending protocol fees
    function pendingProtocolFees() external view returns (uint256);

    /// @notice Subtracts a specified amount from the pending protocol fees
    /// @param amount The amount to subtract from pending protocol fees
    function subtractPendingProtocolFees(uint256 amount) external;

    /// @notice Callback function to decrypt the encrypted values
    /// @param requestID The request ID
    /// @param decryptedValues The decrypted values
    /// @param signatures The signatures
    function callbackPreProcessDecrypt(
        uint256 requestID,
        uint256[] memory decryptedValues,
        bytes[] memory signatures
    ) external;

    /// @notice Get the selling orders
    /// @return tokens The tokens to sell
    /// @return amounts The amounts to sell in shares (converted from underlying assets)
    function getSellingOrders() external view returns (address[] memory, uint256[] memory);

    /// @notice Get the buying orders
    /// @return tokens The tokens to buy
    /// @return amounts The amounts to buy in underlying assets (as expected by LiquidityOrchestrator)
    function getBuyingOrders() external view returns (address[] memory, uint256[] memory);
}
