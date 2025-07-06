// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../interfaces/IRebalancingEngine.sol";
import "../interfaces/IExecutionAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

contract RebalancingEngine is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, IRebalancingEngine {
    mapping(address => IExecutionAdapter) public executionAdapterOf;

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        // Only the owner can upgrade the contract
    }

    /// @notice Register or replace the adapter for an asset.
    function setAdapter(address asset, IExecutionAdapter adapter) external onlyOwner {
        if (asset == address(0) || address(adapter) == address(0)) revert ErrorsLib.ZeroAddress();
        executionAdapterOf[asset] = adapter;
        emit EventsLib.AdapterSet(asset, address(adapter));
    }

    function executeBuy(address asset, uint256 amount) external {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();
        adapter.buy(asset, amount);
    }

    function executeSell(address asset, uint256 amount) external {
        IExecutionAdapter adapter = executionAdapterOf[asset];
        if (address(adapter) == address(0)) revert ErrorsLib.AdapterNotSet();
        adapter.sell(asset, amount);
    }
}
