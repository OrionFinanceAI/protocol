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

    /// @notice Struct to hold vault state data
    struct VaultStateData {
        uint8[] feeTypes;
        uint16[] performanceFees;
        uint16[] managementFees;
        uint256[] highWaterMarks;
        uint256[] pendingRedeems;
        uint256[] pendingDeposits;
        address[][] portfolioTokens;
        uint256[][] portfolioShares;
        address[][] intentTokens;
        uint32[][] intentWeights;
    }

    struct PerformDataStruct {
        bytes _publicValues;
        bytes proofBytes;
        StatesStruct states;
    }

    struct PublicValuesStruct {
        /// @notice Input state commitments
        bytes32 inputCommitment;
        /// @notice Output state commitments
        bytes32 outputCommitment;
    }

    struct StatesStruct {
        bytes32 inputCommitment;
        // TODO: dev, testing an ISO map equal to the input state commitment only
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

    /// @notice Struct representing the full epoch state view
    /// @dev This struct contains all epoch state data in a returnable format
    struct EpochStateView {
        /// @notice Delta buffer amount for current epoch [assets]
        int256 deltaBufferAmount;
        /// @notice Transparent vaults associated to the current epoch
        address[] vaultsEpoch;
        /// @notice Asset addresses in the epoch
        address[] assets;
        /// @notice Prices of assets in the current epoch [priceAdapterDecimals]
        uint256[] assetPrices;
        /// @notice Token decimals for each asset
        uint8[] tokenDecimals;
        /// @notice Active volume fee coefficient for current epoch
        uint16 activeVFeeCoefficient;
        /// @notice Active revenue share fee coefficient for current epoch
        uint16 activeRsFeeCoefficient;
        /// @notice Vault addresses
        address[] vaultAddresses;
        /// @notice Active fee models for vaults in current epoch
        IOrionVault.FeeModel[] vaultFeeModels;
        /// @notice Epoch state commitment
        bytes32 epochStateCommitment;
        /// @notice Underlying asset address
        address underlyingAsset;
        /// @notice Underlying asset decimals
        uint8 underlyingDecimals;
        /// @notice Price adapter decimals
        uint8 priceAdapterDecimals;
        /// @notice Strategist intent decimals
        uint8 strategistIntentDecimals;
        /// @notice Epoch duration
        uint32 epochDuration;
    }

    /// @notice Returns the full epoch state
    /// @dev Returns all epoch state data in a single struct. Use this instead of individual getters.
    /// @return The complete epoch state view
    function getEpochState() external view returns (EpochStateView memory);

    /// @notice Updates the minibatch size for fulfill deposit and redeem processing
    /// @param _minibatchSize The new minibatch size
    function updateMinibatchSize(uint8 _minibatchSize) external;

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Updates the verifier contract address
    /// @param newVerifier The address of the new verifier contract
    function updateVerifier(address newVerifier) external;

    /// @notice Updates the internal state orchestrator verification key
    /// @param newvKey The new verification key
    function updateVKey(bytes32 newvKey) external;

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
