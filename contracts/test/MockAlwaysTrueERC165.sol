// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Non-compliant ERC-165: returns true for every interface ID, including 0xffffffff.
///      Also exposes setVault so strategist-link regressions can assert it was not called.
contract MockAlwaysTrueERC165 {
    bool public vaultLinked;

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    function setVault(address) external {
        vaultLinked = true;
    }
}
