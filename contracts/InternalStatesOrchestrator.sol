// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

// import { euint32 } from "../lib/fhevm-solidity/lib/FHE.sol";
// TODO: euint used here as well in interpreting vault intents based on the encoding communicated by the curator.

contract InternalStatesOrchestrator is Ownable2Step {
    constructor() Ownable(msg.sender) {}
}
