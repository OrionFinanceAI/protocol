// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/ILiquidityOrchestrator.sol";

/// @title Liquidity Orchestrator
/// @notice Orchestrates transaction execution and vault state modifications
/// @dev This contract is responsible for:
///      - Executing actual transactions on vaults and external protocols
///      - Processing deposit and withdrawal requests from vaults
///      - Writing and updating vault states based on executed transactions
///      - Handling slippage and market execution differences from oracle estimates
///      - Managing curator fees.
///
///      IMPORTANT: This contract is triggered by events from the Internal States
///      Orchestrator and is responsible for all state-modifying operations.
///      The Internal States Orchestrator only reads states and performs estimations.
///      This contract handles the actual execution and state writing.
contract LiquidityOrchestrator is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ILiquidityOrchestrator {
    function initialize(address initialOwner) external initializer {
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
        _transferOwnership(initialOwner);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Rebalance portfolio according to desired USD allocations
    /// @dev Implementing a naive execution logic, accumulating error in last position.
    function rebalancePortfolio() external onlyOwner {
        // TODO:
        // 1. Get delta portfolio in underlying asset from inner state orchestrator.
        // 2. Get desired USD target allocations (based on estimated prices)
        // 3. Calculate target shares for all but last asset (using priceOracle.getPrice)
        // 4. Adjust last asset target shares post N-1 executions for rounding/trade error
        // 5. Execute trades to reach target shares via executeTrade()
        // 6. Update internal portfolio shares mapping
        // 7. Emit PortfolioRebalanced event.
        // emit PortfolioRebalanced();
    }

    // TODO: vault states t0, w_0 to be updated at the end of the execution.
    // TODO: required to have the executed vault states (in shares) in the vault state.
    // Overwrite this state from the liquidity orchestrator.
    // TODO: DepositRequest and WithdrawRequest in Vaults to be
    // processed (post t0 update) and removed from vault state as pending requests.
    // TODO: curator fees to be paid at the end of the execution.
    // In the liquidity orchestrator, document that the post execution
    // portfolio state is different from the intent one not only
    // because of slippage, but also because the assets prices have
    // evolved between the oracle call and the execution call.
}
