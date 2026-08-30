// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionEncryptedVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionEncryptedVault
 * @notice A confidential implementation of OrionVault supporting active management strategies
 * @author Orion Finance
 * @custom:security-contact security@orionfinance.ai
 */
contract OrionEncryptedVault is OrionVault, IOrionEncryptedVault {
    /// @notice Minimum ciphertext length.
    uint256 public constant MIN_CIPHERTEXT_LENGTH = 48;

    /// @notice Encrypted portfolio shares per asset (w_0)
    bytes internal _portfolioCiphertext;

    /// @notice Encrypted strategist intent (w_1)
    bytes internal _intentCiphertext;

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the vault
    /// @param manager_ The address of the vault manager
    /// @param strategist_ The address of the vault strategist
    /// @param config_ The address of the OrionConfig contract
    /// @param name_ The name of the vault
    /// @param symbol_ The symbol of the vault
    /// @param feeType_ The fee type
    /// @param performanceFee_ The performance fee
    /// @param managementFee_ The management fee
    /// @param depositAccessControl_ Deposit access control (address(0) = permissionless)
    /// @param holderAccessControl_ Holder access control (address(0) = permissionless)
    /// @param transferAccessControl_ Transfer access control (address(0) = permissionless)
    function initialize(
        address manager_,
        address strategist_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_,
        uint8 feeType_,
        uint16 performanceFee_,
        uint16 managementFee_,
        address depositAccessControl_,
        address holderAccessControl_,
        address transferAccessControl_
    ) public initializer {
        __OrionVault_init(
            manager_,
            strategist_,
            config_,
            name_,
            symbol_,
            feeType_,
            performanceFee_,
            managementFee_,
            depositAccessControl_,
            holderAccessControl_,
            transferAccessControl_
        );
    }

    /// --------- STRATEGIST FUNCTIONS ---------

    /// @inheritdoc IOrionEncryptedVault
    function submitIntent(bytes calldata intentCiphertext) external onlyStrategist {
        if (!config.isSystemIdle()) revert ErrorsLib.SystemNotIdle();

        uint256 len = intentCiphertext.length;
        if (len < MIN_CIPHERTEXT_LENGTH || len > maxCiphertextLength()) {
            revert ErrorsLib.InvalidArguments();
        }

        _intentCiphertext = intentCiphertext;
        emit EventsLib.ConfidentialOrderSubmitted(msg.sender);
    }

    /// @inheritdoc IOrionEncryptedVault
    function maxCiphertextLength() public view returns (uint256) {
        return 176 + 64 * uint256(config.whitelistedAssetsLength());
    }

    /// @inheritdoc IOrionEncryptedVault
    function getPortfolio() external view returns (bytes memory portfolioCiphertext) {
        return _portfolioCiphertext;
    }

    /// @inheritdoc IOrionEncryptedVault
    function getIntent() external view returns (bytes memory intentCiphertext) {
        return _intentCiphertext;
    }

    /// @inheritdoc IOrionEncryptedVault
    function updateVaultState(
        bytes calldata portfolioCiphertext,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        _portfolioCiphertext = portfolioCiphertext;

        _totalAssets = newTotalAssets;

        uint256 currentSharePrice = convertToAssets(10 ** decimals());

        // Advance both HWMs to prevent double-charging during fee cooldown
        if (currentSharePrice > feeModel.highWaterMark) {
            feeModel.highWaterMark = currentSharePrice;
        }
        if (currentSharePrice > oldFeeModel.highWaterMark) {
            oldFeeModel.highWaterMark = currentSharePrice;
        }

        emit EventsLib.ConfidentialVaultStateUpdated(
            newTotalAssets,
            totalSupply(),
            currentSharePrice,
            feeModel.highWaterMark
        );
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
