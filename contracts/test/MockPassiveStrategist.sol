// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IOrionTransparentVault } from "../interfaces/IOrionTransparentVault.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IOrionStrategist } from "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/**
 * @title MockPassiveStrategist
 * @notice Minimal IOrionStrategist for kernel integration tests: 100% weight on first whitelisted asset.
 * @author Orion Finance
 */
contract MockPassiveStrategist is IOrionStrategist, ERC165, Ownable {
    IOrionConfig public immutable config;
    address private _vault;

    constructor(address owner_, address config_) Ownable(owner_) {
        if (config_ == address(0)) revert ErrorsLib.ZeroAddress();
        config = IOrionConfig(config_);
    }

    /// @inheritdoc IOrionStrategist
    function setVault(address vault_) external {
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();
        if (_vault == vault_) return;
        if (_vault != address(0)) revert ErrorsLib.StrategistVaultAlreadyLinked();
        _vault = vault_;
    }

    /// @inheritdoc IOrionStrategist
    function submitIntent() external {
        address vault_ = _vault;
        if (vault_ == address(0)) revert ErrorsLib.ZeroAddress();

        address[] memory assets = config.getAllWhitelistedAssets();
        if (assets.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        uint32 intentScale = uint32(10 ** config.strategistIntentDecimals());
        IOrionTransparentVault.IntentPosition[] memory intent = new IOrionTransparentVault.IntentPosition[](1);
        intent[0] = IOrionTransparentVault.IntentPosition({ token: assets[0], weight: intentScale });

        IOrionTransparentVault(vault_).submitIntent(intent);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IOrionStrategist).interfaceId || super.supportsInterface(interfaceId);
    }
}
