// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ApyStrategistBase } from "./ApyStrategistBase.sol";

/**
 * @title KBestApyEqualWeighted
 * @notice Selects the top-K assets by estimated APY and allocates equal weight to each.
 * @author Orion Finance
 * @dev Call updateCheckpoints() before submitIntent() to refresh APY data.
 * @custom:security-contact security@orionfinance.ai
 */
contract KBestApyEqualWeighted is ApyStrategistBase {
    /// @notice Number of top assets to select.
    uint16 public k;

    /// @notice Deploys the strategy.
    /// @param owner_  Owner of this contract (can update k).
    /// @param config_ The Orion configuration contract address.
    /// @param k_      Number of top assets to select.
    constructor(address owner_, address config_, uint16 k_) ApyStrategistBase(owner_, config_) {
        k = k_;
    }

    /// @inheritdoc IOrionStrategist
    function submitIntent() external override {
        _submitIntentInternal(k);
    }

    /// @notice Update the number of top assets to select.
    /// @param kNew The new k value.
    function updateParameters(uint16 kNew) external onlyOwner {
        k = kNew;
    }

    /// @dev Equal weight across all selected assets. APY is used for selection only.
    ///      Rounding residual is assigned to the first (highest-APY) position.
    function _buildIntent(
        address[] memory tokens,
        uint256[] memory /* topApys — selection only, not used for weighting */,
        uint16 kActual
    ) internal view override returns (IOrionTransparentVault.IntentPosition[] memory intent) {
        uint32 intentScale = uint32(10 ** config.strategistIntentDecimals());
        uint32 equalWeight = uint32(intentScale / kActual);

        intent = new IOrionTransparentVault.IntentPosition[](kActual);
        uint32 sumWeights = 0;
        for (uint16 i = 0; i < kActual; ++i) {
            intent[i] = IOrionTransparentVault.IntentPosition({ token: tokens[i], weight: equalWeight });
            sumWeights += equalWeight;
        }

        // Assign rounding residual to first position to guarantee exact sum.
        if (sumWeights < intentScale) {
            intent[0].weight += intentScale - sumWeights;
        }
    }
}
