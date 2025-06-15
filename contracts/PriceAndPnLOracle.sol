// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

contract PriceAndPnLOracle is Ownable2Step {
    constructor() Ownable(msg.sender) {}
}
