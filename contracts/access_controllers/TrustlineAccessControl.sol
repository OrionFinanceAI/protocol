// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IOrionAccessControl } from "../interfaces/IOrionAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Trustlined} from "@trustline.id/evmsdk/contracts/Trustlined.sol";

/**
 * @title TrustlineAccessControl
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract TrustlineAccessControl is IOrionAccessControl, Ownable2Step, Trustlined {
    /// @notice Constructor
    /// @param initialOwner_ The address of the initial owner
    /// @param trustlineValidationEngineLogic The address of the trustline validation engine logic
    /// @param trustlineValidationEngineProxy The address of the trustline validation engine proxy
    constructor(
        address initialOwner_,
        address trustlineValidationEngineLogic,
        address trustlineValidationEngineProxy
    ) Ownable(initialOwner_) Trustlined(trustlineValidationEngineLogic, trustlineValidationEngineProxy) {}


    /// @inheritdoc IOrionAccessControl
    function canRequestDeposit(address sender, bytes calldata data) external view override returns (bool) {
        return validationEngine.checkTrustlineStatus(sender, 0, data);
    }
}
