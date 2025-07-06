// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint32 } from "fhevm/lib/TFHE.sol";
import "./IOrionVault.sol";

interface IOrionEncryptedVault is IOrionVault {
    struct EncryptedPosition {
        address token;
        euint32 weight;
    }

    /// @notice Submit an encrypted portfolio intent.
    /// @param order EncryptedPosition struct containing the tokens and encrypted weights.
    function submitIntent(EncryptedPosition[] calldata order) external;

    /// @notice Returns the current portfolio (w_0)
    function getPortfolio() external view returns (address[] memory tokens, euint32[] memory sharesPerAsset);

    /// @notice Get the encrypted intent.
    /// @return tokens The tokens in the intent.
    /// @return weights The weights in the intent.
    function getIntent() external view returns (address[] memory tokens, euint32[] memory weights);

    // TODO: add docstring once implemented.
    function updateVaultState(EncryptedPosition[] calldata portfolio, uint256 newTotalAssets) external;
}
