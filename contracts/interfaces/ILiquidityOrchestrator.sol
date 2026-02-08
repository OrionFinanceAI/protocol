// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IExecutionAdapter.sol";
import "./IOrionVault.sol";

/// @title ILiquidityOrchestrator
/// @notice Interface for the liquidity orchestrator
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
interface ILiquidityOrchestrator {
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
        uint256[] totalSupplies;
        address[][] portfolioTokens;
        uint256[][] portfolioShares;
        address[][] intentTokens;
        uint32[][] intentWeights;
    }

    struct PublicValuesStruct {
        /// @notice Input state commitments
        bytes32 inputCommitment;
        /// @notice Output state commitments
        bytes32 outputCommitment;
    }

    struct StatesStruct {
        VaultState[] vaults;
        SellLegOrders sellLeg;
        BuyLegOrders buyLeg;
        uint256 bufferAmount;
        uint256 epochProtocolFees;
    }

    struct VaultState {
        uint256 totalAssetsForRedeem;
        uint256 totalAssetsForDeposit;
        uint256 finalTotalAssets;
        uint256 managementFee;
        uint256 performanceFee;
        address[] tokens;
        uint256[] shares;
    }

    struct SellLegOrders {
        address[] sellingTokens;
        uint256[] sellingAmounts;
        uint256[] sellingEstimatedUnderlyingAmounts;
    }

    struct BuyLegOrders {
        address[] buyingTokens;
        uint256[] buyingAmounts;
        uint256[] buyingEstimatedUnderlyingAmounts;
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
        /// @notice Transparent vaults associated to the current epoch
        address[] vaultsEpoch;
        /// @notice Active volume fee coefficient for current epoch
        uint16 activeVFeeCoefficient;
        /// @notice Active revenue share fee coefficient for current epoch
        uint16 activeRsFeeCoefficient;
        /// @notice Active fee models for vaults in current epoch
        IOrionVault.FeeModel[] vaultFeeModels;
        /// @notice Epoch state commitment
        bytes32 epochStateCommitment;
    }

    /// @notice Returns the full epoch state
    /// @dev Returns all epoch state data in a single struct. Use this instead of individual getters.
    /// @return The complete epoch state view
    function getEpochState() external view returns (EpochStateView memory);

    /// @notice Returns tokens that failed during the current epoch's sell/buy execution
    /// @return List of token addresses that failed
    function getFailedEpochTokens() external view returns (address[] memory);

    /// @notice Gets asset prices for the epoch
    /// @param assets Array of asset addresses
    /// @return assetPrices Array of asset prices
    function getAssetPrices(address[] memory assets) external view returns (uint256[] memory assetPrices);

    /// @notice Updates the execution minibatch size
    /// @param _executionMinibatchSize The new execution minibatch size
    function updateExecutionMinibatchSize(uint8 _executionMinibatchSize) external;

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
    function setTargetBufferRatio(uint256 _targetBufferRatio) external;

    /// @notice Sets the slippage tolerance
    /// @param _slippageTolerance The new slippage tolerance
    function setSlippageTolerance(uint256 _slippageTolerance) external;

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

    /// @notice Pauses protocol operations for the orchestrator
    /// @dev Can only be called by guardian or owner for emergency situations
    function pause() external;

    /// @notice Unpauses protocol operations for the orchestrator
    /// @dev Can only be called by owner after resolving emergency
    ///      (not guardian: requires owner approval to resume)
    function unpause() external;

    /// @notice Checks if upkeep is needed
    /// @return upkeepNeeded Whether upkeep is needed
    /// @dev the API is inspired but different from the Chainlink Automation interface.
    function checkUpkeep() external view returns (bool upkeepNeeded);

    /// @notice Performs the upkeep
    /// @param _publicValues Encoded PublicValuesStruct containing input and output commitments
    /// @param proofBytes The zk-proof bytes
    /// @param statesBytes Encoded StatesStruct containing vaults, buy leg, and sell leg data
    /// @dev the API is inspired but different from the Chainlink Automation interface.
    function performUpkeep(
        bytes calldata _publicValues,
        bytes calldata proofBytes,
        bytes calldata statesBytes
    ) external;
}
