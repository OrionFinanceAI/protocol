// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
/**
 * @title ERC4626PriceAdapter
 * @notice Price adapter for ERC-4626 vaults.
 * @author Orion Finance
 * @dev Composes vault share → underlying → USDC pricing via oracle
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
 * Security:
 * - Validates underlying has price feed during registration
 * - Uses protocol's price adapter decimals for normalization (14 decimals)
 * - Handles arbitrary underlying decimals (WBTC=8, WETH=18, etc.)
 * - Does NOT support same-asset vaults (underlying == USDC)
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ERC4626PriceAdapter is IPriceAdapter {
    using Math for uint256;

    /// @notice Orion Config contract address
    IOrionConfig public immutable CONFIG;

    /// @notice Price adapter registry for underlying asset prices
    IPriceAdapterRegistry public immutable PRICE_REGISTRY;

    /// @notice Protocol underlying asset (USDC)
    IERC20Metadata public immutable UNDERLYING_ASSET;

    /// @notice Underlying asset decimals (6 for USDC)
    uint8 public immutable UNDERLYING_DECIMALS;

    /// @notice Price adapter decimals for normalization (14)
    uint8 public immutable PRICE_ADAPTER_DECIMALS;

    /// @notice Constructor
    /// @param configAddress The address of the OrionConfig contract
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        CONFIG = IOrionConfig(configAddress);
        PRICE_REGISTRY = IPriceAdapterRegistry(CONFIG.priceAdapterRegistry());
        UNDERLYING_ASSET = IERC20Metadata(address(CONFIG.underlyingAsset()));
        UNDERLYING_DECIMALS = UNDERLYING_ASSET.decimals();
        PRICE_ADAPTER_DECIMALS = CONFIG.priceAdapterDecimals();
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view {
        // 1. Verify asset implements IERC4626
        address underlying = address(0);
        try IERC4626(asset).asset() returns (address _underlying) {
            underlying = _underlying;
            if (underlying == address(0)) revert ErrorsLib.InvalidAdapter(asset);

            // Verify underlying is NOT the protocol underlying (use standard adapter for that)
            if (underlying == address(UNDERLYING_ASSET)) {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // 2. Verify underlying has a price feed registered
        // This is CRITICAL - we need underlying → USDC pricing
        // slither-disable-next-line unused-return
        try PRICE_REGISTRY.getPrice(underlying) returns (uint256) {
            // solhint-disable-previous-line no-empty-blocks
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        // 3. Verify vault decimals are registered in config
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != CONFIG.getTokenDecimals(asset)) {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address vaultAsset) external view returns (uint256 price, uint8 decimals) {
        IERC4626 vault = IERC4626(vaultAsset);
        address underlying = vault.asset();

        // Step 1: Get vault share → underlying conversion
        // Calculate how much underlying per 1 vault share
        uint8 vaultDecimals = IERC20Metadata(vaultAsset).decimals();
        uint256 oneShare = 10 ** vaultDecimals;
        uint256 underlyingPerShare = vault.convertToAssets(oneShare);

        // Step 2: Get underlying → USDC price from oracle
        // Price is already normalized to PRICE_ADAPTER_DECIMALS (14 decimals)
        uint256 underlyingPriceInNumeraire = PRICE_REGISTRY.getPrice(underlying);

        // Step 3: Compose prices
        // Formula: (underlying/share) × (USDC/underlying) = USDC/share
        //
        // underlyingPerShare is in underlying decimals
        // underlyingPriceInNumeraire is in PRICE_ADAPTER_DECIMALS
        // Result should be in PRICE_ADAPTER_DECIMALS
        //
        // Example:
        // - underlyingPerShare = 1.05e18 (WETH, 18 decimals)
        // - underlyingPriceInNumeraire = 3000e14 (price in 14 decimals)
        // - Result = (1.05e18 × 3000e14) / 1e18 = 3150e14

        uint8 underlyingDecimalsLocal = IERC20Metadata(underlying).decimals();
        uint256 priceInNumeraire = underlyingPerShare.mulDiv(underlyingPriceInNumeraire, 10 ** underlyingDecimalsLocal);

        return (priceInNumeraire, PRICE_ADAPTER_DECIMALS);
    }
}
