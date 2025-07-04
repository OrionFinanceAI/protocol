# Orion Protocol Contracts

This directory contains the smart contracts for the Orion Protocol, including the core orchestrator contracts that manage vault operations and state transitions.

## Orchestrator Architecture

The protocol uses a two-tier orchestrator architecture to separate concerns between state estimation and transaction execution:

### Internal States Orchestrator (ISO)

**Purpose**: State reading and estimation operations

**Responsibilities**:
- Reads current vault states and market data
- Calculates P&L estimations based on oracle price updates
- Computes state estimations for vault portfolio performance
- Emits events to trigger the Liquidity Orchestrator
- Performs read-only operations and calculations

**Key Characteristics**:
- Triggered by Chainlink Automation on a periodic basis
- Does NOT execute transactions or modify vault states
- Only performs read operations and calculations for state estimation
- Oracle data is used for estimation only, not for direct state updates

**Main Functions**:
- `performUpkeep()`: Reads states, calculates P&L estimations, emits events
- `_updateOraclePricesAndCalculatePnL()`: Updates oracle prices and calculates percentage changes
- `onePlusDotProduct()`: Calculates portfolio performance estimations

### Liquidity Orchestrator (LO)

**Purpose**: Transaction execution and vault state modifications

**Responsibilities**:
- Executes actual transactions on vaults and external protocols
- Processes deposit and withdrawal requests from vaults
- Writes and updates vault states based on executed transactions
- Handles slippage and market execution differences from oracle estimates
- Manages portfolio rebalancing and asset allocation changes

**Key Characteristics**:
- Triggered by events from the Internal States Orchestrator
- Responsible for all state-modifying operations
- Handles actual execution and state writing
- Manages the difference between oracle estimates and execution prices

**Main Functions** (to be implemented):
- `processDepositRequests()`: Process pending deposit requests
- `processWithdrawalRequests()`: Process pending withdrawal requests
- `executeRebalancing()`: Execute portfolio rebalancing transactions
- `updateVaultStates()`: Update vault states after successful executions

## Architecture Benefits

1. **Separation of Concerns**: Clear distinction between estimation (ISO) and execution (LO)
2. **Risk Management**: Oracle estimates are separate from execution prices
3. **Scalability**: Read operations can be optimized separately from write operations
4. **Reliability**: Failed executions don't affect state estimations
5. **Transparency**: Clear audit trail between estimation and execution phases

## Workflow

1. **ISO Phase**: Chainlink Automation triggers ISO to read states and calculate estimations
2. **Event Emission**: ISO emits `InternalStateProcessed` event with estimation data
3. **LO Phase**: Liquidity Orchestrator processes the event and executes transactions
4. **State Update**: LO updates vault states based on actual execution results

## Important Notes

- Oracle prices used in ISO may differ from execution prices due to slippage and market evolution
- The ISO performs estimations only; actual state changes are handled by the LO
- Failed transactions in LO do not affect the estimation calculations in ISO
- Both orchestrators are upgradeable to allow for future improvements
