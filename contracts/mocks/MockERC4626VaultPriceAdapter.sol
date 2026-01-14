// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MockERC4626VaultPriceAdapter
 * @notice Mock price adapter for ERC4626 vaults for testing
 * @author Orion Finance
 * @dev Test-only adapter. Composes vault share → underlying → USDC pricing via oracle
 *
 * Pricing Flow:
 * 1. Get vault share → underlying conversion rate (via ERC4626.convertToAssets)
 * 2. Get underlying → USDC price (via PriceAdapterRegistry oracle)
 * 3. Multiply: (underlying/share) × (USDC/underlying) = USDC/share
 *
 * Example (Cross-asset):
 * - Vault: Yearn WETH (yvWETH)
 * - 1 yvWETH = 1.05 WETH (vault appreciation)
 * - 1 WETH = 3000 USDC (from Chainlink oracle)
 * - Result: 1 yvWETH = 1.05 × 3000 = 3150 USDC
 *
 * Example (Same-asset):
 * - Vault: USDC vault
 * - 1 vault share = 1.02 USDC (vault appreciation)
 * - 1 USDC = 1 USDC (identity pricing)
 * - Result: 1 vault share = 1.02 USDC
 *
 * Security:
 * - Validates underlying has price feed during registration
 * - Uses protocol's price adapter decimals for normalization (14 decimals)
 * - Handles arbitrary underlying decimals (WBTC=8, WETH=18, USDC=6, etc.)
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract MockERC4626VaultPriceAdapter is IPriceAdapter {
    using Math for uint256;

    /// @notice Orion protocol configuration contract
    IOrionConfig public immutable config;

    /// @notice Price adapter registry for underlying asset prices
    IPriceAdapterRegistry public immutable priceRegistry;

    /// @notice Protocol underlying asset (USDC)
    IERC20Metadata public immutable underlyingAsset;

    /// @notice Underlying asset decimals (6 for USDC)
    uint8 public immutable underlyingDecimals;

    /// @notice Price adapter decimals for normalization (14)
    uint8 public immutable priceAdapterDecimals;

    /**
     * @notice Constructor
     * @param configAddress OrionConfig contract address
     */
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        priceRegistry = IPriceAdapterRegistry(config.priceAdapterRegistry());
        underlyingAsset = IERC20Metadata(address(config.underlyingAsset()));
        underlyingDecimals = underlyingAsset.decimals();
        priceAdapterDecimals = config.priceAdapterDecimals();
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view override {
        // 1. Verify asset implements IERC4626
        address underlying = address(0);
        try IERC4626(asset).asset() returns (address _underlying) {
            underlying = _underlying;
            if (underlying == address(0)) revert ErrorsLib.InvalidAdapter(asset);

            // Verify underlying is NOT the protocol underlying (use standard adapter for that)
            if (underlying == address(underlyingAsset)) {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // 2. Verify underlying has a price feed registered
        // This is CRITICAL - we need underlying → USDC pricing
        // slither-disable-next-line unused-return
        try priceRegistry.getPrice(underlying) returns (uint256) {
            // Price feed exists and is callable
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // 3. Verify vault decimals are registered in config
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != config.getTokenDecimals(asset)) {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address vaultAsset) external view override returns (uint256 price, uint8 decimals) {
        IERC4626 vault = IERC4626(vaultAsset);
        address underlying = vault.asset();

        // Step 1: Get vault share → underlying conversion
        // Calculate how much underlying per 1 vault share
        uint8 vaultDecimals = IERC20Metadata(vaultAsset).decimals();
        uint256 oneShare = 10 ** vaultDecimals;
        uint256 underlyingPerShare = vault.convertToAssets(oneShare);

        // Step 2: Get underlying → USDC price from oracle
        // Price is already normalized to priceAdapterDecimals (14 decimals)
        uint256 underlyingPriceInNumeraire = priceRegistry.getPrice(underlying);

        // Step 3: Compose prices
        // Formula: (underlying/share) × (USDC/underlying) = USDC/share
        //
        // underlyingPerShare is in underlying decimals
        // underlyingPriceInNumeraire is in priceAdapterDecimals
        // Result should be in priceAdapterDecimals
        //
        // Example:
        // - underlyingPerShare = 1.05e18 (WETH, 18 decimals)
        // - underlyingPriceInNumeraire = 3000e14 (price in 14 decimals)
        // - Result = (1.05e18 × 3000e14) / 1e18 = 3150e14

        uint8 underlyingDecimals = config.getTokenDecimals(underlying);

        uint256 priceInNumeraire = underlyingPerShare.mulDiv(underlyingPriceInNumeraire, 10 ** underlyingDecimals);

        return (priceInNumeraire, priceAdapterDecimals);
    }
}
