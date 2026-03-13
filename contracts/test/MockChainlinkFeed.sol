// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @dev Minimal Chainlink aggregator mock for unit testing ChainlinkPriceAdapter.
///      Simulates a feed with configurable decimals, answer, and updatedAt.
contract MockChainlinkFeed is AggregatorV3Interface {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;

    constructor(uint8 decimals_, int256 answer_) {
        _decimals = decimals_;
        _answer = answer_;
        _updatedAt = block.timestamp;
        _roundId = 1;
    }

    function setAnswer(int256 answer_) external { _answer = answer_; }
    function setUpdatedAt(uint256 updatedAt_) external { _updatedAt = updatedAt_; }

    function decimals() external view override returns (uint8) { return _decimals; }
    function description() external pure override returns (string memory) { return "MockFeed"; }
    function version() external pure override returns (uint256) { return 1; }

    function latestRoundData() external view override returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return (_roundId, _answer, block.timestamp, _updatedAt, _roundId);
    }

    function getRoundData(uint80) external view override returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        return (_roundId, _answer, block.timestamp, _updatedAt, _roundId);
    }
}
