// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { euint32 } from "../lib/fhevm-solidity/lib/FHE.sol";
// TODO: euint used here as well in interpreting vault intents based on the encoding communicated by the curator.

contract InternalStatesOrchestrator {
    address public owner;

    constructor() {
        owner = msg.sender;
    }
}
