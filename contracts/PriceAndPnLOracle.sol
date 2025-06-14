// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

contract PriceAndPnLOracle {
    address public owner;

    constructor() {
        owner = msg.sender;
    }
}
