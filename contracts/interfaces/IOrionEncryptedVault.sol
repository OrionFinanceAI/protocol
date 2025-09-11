// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint128, externalEuint128 } from "@fhevm/solidity/lib/FHE.sol";

import "./IOrionVault.sol";

/// @title IOrionEncryptedVault
/// @notice Interface for the Orion encrypted vault
/// @author Orion Finance
interface IOrionEncryptedVault is IOrionVault {
    struct EncryptedIntent {
        address token;
        externalEuint128 weight;
    }

    struct EncryptedPortfolio {
        address token;
        euint128 value;
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
    function getPortfolio() external view returns (address[] memory tokens, euint128[] memory sharesPerAsset);

    /// @notice Get the encrypted intent.
    /// @return tokens The tokens in the intent.
    /// @return weights The weights in the intent.
    function getIntent() external view returns (address[] memory tokens, euint128[] memory weights);

    /// @notice Get the intent validity.
    /// @return isIntentValid Whether the intent is valid.
    function isIntentValid() external view returns (bool);

    /// @notice Updates the vault's portfolio state and total assets
    /// @dev Can only be called by the liquidity orchestrator.
    ///      Clears the previous portfolio and replaces it with the new one.
    /// @param portfolio Array of EncryptedPortfolio structs
    ///        It contains the new portfolio token addresses and encrypted number of shares per asset.
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(EncryptedPortfolio[] calldata portfolio, uint256 newTotalAssets) external;

    /// @notice Callback function to decrypt a single ebool
    /// @param requestID The request ID
    /// @param cleartexts The cleartexts
    /// @param decryptionProof The decryption proof
    function callbackDecryptSingleEbool(
        uint256 requestID,
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external;
}
