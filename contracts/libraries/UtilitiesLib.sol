// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title UtilitiesLib
 * @notice Library for utility functions
 * @author Orion Finance
 * @dev This library provides utility functions for common operations.
 * @custom:security-contact security@orionfinance.ai
 */
library UtilitiesLib {
    /**
     * @notice Converts a value from one decimal precision to another
     * @param value The value to convert
     * @param fromDecimals The number of decimals in the source value
     * @param toDecimals The number of decimals to convert to
     * @return convertedValue The value converted to the target decimals
     */
    function convertDecimals(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256 convertedValue) {
        if (toDecimals > fromDecimals) {
            // Scale up: multiply by the difference
            convertedValue = value * (10 ** (toDecimals - fromDecimals));
        } else if (toDecimals < fromDecimals) {
            // Scale down: divide by the difference
            convertedValue = value / (10 ** (fromDecimals - toDecimals));
        } else {
            // No conversion needed if decimals are the same
            convertedValue = value;
        }
    }
}
