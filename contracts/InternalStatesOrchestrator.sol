// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../lib/fhevm-solidity/lib/FHE.sol";
// TODO: euint used here in interpreting vault intents based on the encoding communicated by the curator.

contract InternalStatesOrchestrator {
    address public owner;

    constructor() {
        owner = msg.sender;
    }
}
