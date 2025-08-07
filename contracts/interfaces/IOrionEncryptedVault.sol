// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint32, externalEuint32 } from "@fhevm/solidity/lib/FHE.sol";

import "./IOrionVault.sol";

/// @title IOrionEncryptedVault
interface IOrionEncryptedVault is IOrionVault {
    struct EncryptedIntent {
        address token;
        externalEuint32 weight;
    }

    struct EncryptedPortfolio {
        address token;
        euint32 value;
    }

    /// @notice Submit an encrypted portfolio intent.
    /// @param intent EncryptedIntent struct containing the tokens and encrypted weights.
    /// @param inputProof contains the ZKPoK to validate the authenticity of the encrypted inputs.
    ///        https://docs.zama.ai/protocol/solidity-guides/smart-contract/inputs#validating-encrypted-inputs
    /// @dev The weights are interpreted as percentage of total supply.
    function submitIntent(EncryptedIntent[] calldata intent, bytes calldata inputProof) external;

    /// @notice Returns the current encrypted portfolio (w_0)
    /// @return tokens The tokens in the portfolio.
    /// @return sharesPerAsset The shares per asset in the portfolio.
    function getPortfolio() external view returns (address[] memory tokens, euint32[] memory sharesPerAsset);

    /// @notice Get the encrypted intent.
    /// @return tokens The tokens in the intent.
    /// @return weights The weights in the intent.
    function getIntent() external view returns (address[] memory tokens, euint32[] memory weights);

    /// @notice Updates the vault's portfolio state and total assets
    /// @dev Can only be called by the liquidity orchestrator.
    ///      Clears the previous portfolio and replaces it with the new one.
    /// @param portfolio Array of EncryptedPortfolio structs
    ///        It contains the new portfolio token addresses and encrypted number of shares per asset.
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(EncryptedPortfolio[] calldata portfolio, uint256 newTotalAssets) external;
}
