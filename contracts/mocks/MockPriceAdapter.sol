// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";

/// @title Price Adapter mock
/// @notice One instance per asset. Produces pseudo‑random prices for testing.
contract MockPriceAdapter is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IPriceAdapter {
    /// @notice Asset this price adapter is bound to.
    address public asset;

    function initialize(address asset_, address initialOwner) external initializer {
        if (asset_ == address(0)) revert ErrorsLib.ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        asset = asset_;
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @inheritdoc IPriceAdapter
    function price() external view returns (uint256) {
        // *** Mock randomness *** — DO NOT use in production, returning values between 1 and 100
        return (uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, asset))) % 100) + 1;
    }
}
