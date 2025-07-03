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
///      - Managing portfolio rebalancing and asset allocation changes
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

    // TODO: DepositRequest and WithdrawRequest in Vaults to be
    // processed and removed from vault state as pending requests.
}
