// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

interface IOwnable2Step {
    function acceptOwnership() external;
    function removeWhitelistedManager(address manager) external;
}

/**
 * @title MaliciousManagerRemovalVault
 * @notice Reenters `removeWhitelistedManager` from `overrideIntentForDecommissioning`
 *         so the outer `EnumerableSet.remove` returns false (OrionConfig InvalidAddress branch).
 */
contract MaliciousManagerRemovalVault {
    IOrionConfig public immutable config;
    address public immutable manager;
    bool private reentered;

    constructor(IOrionConfig config_, address manager_) {
        config = config_;
        manager = manager_;
    }

    function acceptOwnership() external {
        IOwnable2Step(address(config)).acceptOwnership();
    }

    function triggerRemoveManager() external {
        IOwnable2Step(address(config)).removeWhitelistedManager(manager);
    }

    function overrideIntentForDecommissioning() external {
        if (msg.sender != address(config)) revert ErrorsLib.NotAuthorized();
        if (reentered) return;
        reentered = true;
        IOwnable2Step(address(config)).removeWhitelistedManager(manager);
    }
}
