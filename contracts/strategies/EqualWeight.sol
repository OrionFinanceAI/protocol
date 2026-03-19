// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/**
 * @title EqualWeight
 * @notice Allocates the portfolio equally across all whitelisted assets. Rounding residual
 *         is assigned to the first asset (config insertion order).
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract EqualWeight is IOrionStrategist, ERC165 {
    /// @notice The Orion configuration contract.
    IOrionConfig public immutable config;

    address private _vault;

    /// @notice Deploys the strategy.
    /// @param config_ The Orion configuration contract address.
    constructor(address config_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(config_);
    }

    /// @inheritdoc IOrionStrategist
    function setVault(address vault_) external override {
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (_vault == vault_) return;
        if (_vault != address(0)) revert ErrorsLib.StrategistVaultAlreadyLinked();
        _vault = vault_;
    }

    /// @inheritdoc IOrionStrategist
    function submitIntent() external override {
        address vault_ = _vault;
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();

        address[] memory assets = config.getAllWhitelistedAssets();
        uint256 n = assets.length;
        if (n == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        uint32 intentScale = uint32(10 ** config.strategistIntentDecimals());
        uint32 equalWeight = uint32(intentScale / n);

        IOrionTransparentVault.IntentPosition[] memory intent = new IOrionTransparentVault.IntentPosition[](n);
        uint32 sumWeights = 0;
        for (uint256 i = 0; i < n; ++i) {
            intent[i] = IOrionTransparentVault.IntentPosition({ token: assets[i], weight: equalWeight });
            sumWeights += equalWeight;
        }

        // Assign rounding residual to first position to guarantee exact sum.
        if (sumWeights < intentScale) {
            intent[0].weight += intentScale - sumWeights;
        }

        IOrionTransparentVault(vault_).submitIntent(intent);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IOrionStrategist).interfaceId || super.supportsInterface(interfaceId);
    }
}
