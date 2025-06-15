// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract LiquidityOrchestrator is Ownable2Step {
    constructor() Ownable(msg.sender) {}

    // TODO: DepositRequest and WithdrawRequest in Vaults to be
    // processed and removed from vault state as pending requests.
}
