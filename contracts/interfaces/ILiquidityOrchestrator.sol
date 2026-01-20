// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IExecutionAdapter.sol";
import "./IOrionVault.sol";

/// @title ILiquidityOrchestrator
/// @notice Interface for the liquidity orchestrator
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
interface ILiquidityOrchestrator is AutomationCompatibleInterface {
    /// @notice Upkeep phase enum for liquidity orchestration
    enum LiquidityUpkeepPhase {
        Idle,
        StateCommitment,
        SellingLeg,
        BuyingLeg,
        ProcessVaultOperations
    }

    /// @notice Returns the current upkeep phase
    /// @return The current LiquidityUpkeepPhase
    function currentPhase() external view returns (LiquidityUpkeepPhase);

    /// @notice Returns the target buffer ratio
    /// @return The target buffer ratio
    function targetBufferRatio() external view returns (uint256);

    /// @notice Returns the slippage tolerance
    /// @return The slippage tolerance
    function slippageTolerance() external view returns (uint256);

    /// @notice Returns the current buffer amount
    /// @return The current buffer amount
    function bufferAmount() external view returns (uint256);

    /// @notice Returns the pending protocol fees
    /// @return The pending protocol fees
    function pendingProtocolFees() external view returns (uint256);

    /// @notice Returns the epoch duration
    /// @return The epoch duration in seconds
    function epochDuration() external view returns (uint32);

    /// @notice Updates the epoch duration
    /// @param newEpochDuration The new epoch duration in seconds
    function updateEpochDuration(uint32 newEpochDuration) external;

    /// @notice Get price for a specific token
    /// @param token The token to get the price of
    /// @return price The corresponding price [shares/assets]
    function getPriceOf(address token) external view returns (uint256 price);

    /// @notice Returns the active protocol fees for the current epoch
    /// @dev These are snapshotted at epoch start to ensure consistency throughout the epoch
    /// @return activeVFeeCoefficient The active volume fee coefficient
    /// @return activeRsFeeCoefficient The active revenue share fee coefficient
    function getActiveProtocolFees()
        external
        view
        returns (uint16 activeVFeeCoefficient, uint16 activeRsFeeCoefficient);

    /// @notice Returns the active fee model for a specific vault in the current epoch
    /// @dev The fee model is snapshotted at epoch start to ensure consistency throughout the epoch
    /// @param vault The address of the vault
    /// @return The active fee model for the vault
    function getVaultFees(address vault) external view returns (IOrionVault.FeeModel memory);

    /// @notice Returns the epoch state root
    /// @return The epoch state root
    function getEpochStateRoot() external view returns (bytes32);

    /// @notice Updates the minibatch size for fulfill deposit and redeem processing
    /// @param _minibatchSize The new minibatch size
    function updateMinibatchSize(uint8 _minibatchSize) external;

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Sets the target buffer ratio
    /// @param _targetBufferRatio The new target buffer ratio
    /// @dev Slippage tolerance is set to 50% of targetBufferRatio to support worst-case scenario prices
    ///      and full NAV rebalancing. This ensures ALL trades pass even with maximum price impact.
    function setTargetBufferRatio(uint256 _targetBufferRatio) external;

    /// @notice Claim protocol fees with specified amount
    /// @dev Called by the Owner to claim a specific amount of protocol fees
    /// @param amount The amount of protocol fees to claim
    function claimProtocolFees(uint256 amount) external;

    /// @notice Register or replace the execution adapter for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The execution adapter for the asset.
    /// @dev Can only be called by the Orion Config contract.
    function setExecutionAdapter(address asset, IExecutionAdapter adapter) external;

    /// @notice Return deposit funds to a user who cancelled their deposit request
    /// @dev Called by vault contracts when users cancel deposit requests
    /// @param user The user to return funds to
    /// @param amount The amount to return
    function returnDepositFunds(address user, uint256 amount) external;

    /// @notice Transfer pending fees to manager
    /// @dev Called by vault contracts when managers claim their fees
    /// @param amount The amount of fees to transfer
    function transferVaultFees(uint256 amount) external;

    /// @notice Transfer redemption funds to a user after shares are burned
    /// @dev Called by vault contracts when processing redemption requests
    /// @param user The user to transfer funds to
    /// @param amount The amount of underlying assets to transfer
    function transferRedemptionFunds(address user, uint256 amount) external;

    /// @notice Deposits underlying assets to the liquidity orchestrator buffer
    /// @dev Increases the buffer amount by the deposited amount.
    /// @param amount The amount of underlying assets to deposit
    function depositLiquidity(uint256 amount) external;

    /// @notice Withdraws underlying assets from the liquidity orchestrator buffer
    /// @dev Can only be called by the owner. Decreases the buffer amount by the withdrawn amount.
    ///      Includes safety checks to prevent predatory withdrawals that could break protocol operations.
    /// @param amount The amount of underlying assets to withdraw
    function withdrawLiquidity(uint256 amount) external;

    /// @notice Synchronous redemption for decommissioned vaults
    /// @dev Called by vault contracts to process synchronous redemptions for LPs with share tokens
    /// @param assets The amount of underlying assets to withdraw
    /// @param receiver The address to receive the underlying assets
    function withdraw(uint256 assets, address receiver) external;

    /// @notice Pauses the contract
    /// @dev Can only be called by OrionConfig for emergency situations
    function pause() external;

    /// @notice Unpauses the contract
    /// @dev Can only be called by OrionConfig after resolving emergency
    function unpause() external;
}
