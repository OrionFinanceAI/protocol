// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract ERC4626PriceAdapter is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IPriceAdapter {
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    function price(address asset) external view returns (uint256) {
        uint8 shareDecimals = IERC20Metadata(asset).decimals();
        uint8 assetDecimals = IERC20Metadata(IERC4626(asset).asset()).decimals();
        uint256 oneShare = 10 ** shareDecimals;
        uint256 assetAmount = IERC4626(asset).convertToAssets(oneShare);
        // Normalize the price to 18 decimals regardless of asset decimals
        if (assetDecimals == 18) {
            return assetAmount;
        } else if (assetDecimals < 18) {
            return assetAmount * (10 ** (18 - assetDecimals));
        } else {
            return assetAmount / (10 ** (assetDecimals - 18));
        }
    }
}
