// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IOracleRegistry.sol";
import "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

contract OracleRegistry is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IOracleRegistry {
    mapping(address => IPriceAdapter) public adapterOf;
    address public configAddress;

    modifier onlyConfig() {
        require(msg.sender == configAddress, "Caller is not the config");
        _;
    }

    function initialize(address initialOwner, address _configAddress) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        configAddress = _configAddress;
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Register or replace the adapter for an asset.
    function setAdapter(address asset, IPriceAdapter adapter) external onlyConfig {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        adapterOf[asset] = adapter;
        emit EventsLib.AdapterSet(asset, address(adapter));
    }

    /// @notice Returns the price of the given asset via its assigned price adapter.
    /// @param asset The address of the asset.
    /// @return The price of the asset, normalized to 18 decimals.
    /// @dev The asset must be assigned an adapter in `adapterOf`.
    ///      Reverts if no adapter is set.
    ///      The returned price is always expected to have 18 decimals.
    function getPrice(address asset) external view returns (uint256) {
        IPriceAdapter adapter = adapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();
        return adapter.price(asset);
    }
}
