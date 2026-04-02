// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Id, MarketParams } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { MarketParamsLib } from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import { SharesMathLib } from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";

/// @title Morpho Blue library fuzz tests (Hardhat 3 native Solidity tests)
/// @notice Fuzzes Morpho Blue `MarketParamsLib` / `SharesMathLib` (used by MorphoBalancesLib → ERC-4626 `totalAssets()`).
/// @dev No forge-std: use `require` for assertions and guard clauses instead of `vm.assume` (see Hardhat 3 Solidity tests).
///
///      **Scope (what this file is / is not)** — Strong coverage of Morpho’s pure share math and market id hashing.
///      It does not yet replace an integration layer: natural next steps are fork or mock `IMorpho` tests for
///      `MorphoBlueSupplyVault` invariants such as `previewDeposit`/`deposit` and `previewRedeem`/`redeem` consistency,
///      `convertToAssets(totalSupply)` vs `totalAssets()` within rounding, and “vault holds zero loan tokens after
///      deposit/withdraw” (those need live `supply`/`withdraw` + `expectedSupplyAssets`).
///
///      **Fuzz domain** — Magnitude caps (~`1e30`) shrink the search space to a safe representative region and avoid
///      overflow in products like `assets * (totalShares + VIRTUAL_SHARES)`. That is intentional for Hardhat-native
///      fuzzing; a Foundry port may prefer algebraic preconditions (e.g. `mul` overflow checks) instead of blunt caps.
///
///      **Dust vs integration tests** — `SharesMathLib` floor/ceil pairs on the *same* conversion differ by at most one
///      unit in that domain (shares or assets). The cross-asset TS suite’s `MORPHO_SHARES_DUST` (`10_000_000n`) is an
///      empirical bound on residual *Morpho market* `supplyShares` after composed ERC-4626 + Morpho rounding — much
///      larger than 1 because OZ and Morpho stack conversions; see `test/crossAsset/MorphoBlueSupplyVault.test.ts`.
contract MorphoBlueFuzzTest {
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;

    /// @dev Mirrors Morpho `SharesMathLib` virtual liquidity (empty market).
    uint256 private constant _VIRTUAL_ASSETS = 1;
    uint256 private constant _VIRTUAL_SHARES = 1e6;

    // --- Market id ---

    /// @notice Market id is deterministic for identical `MarketParams` (keccak256 over packed struct).
    function testFuzz_MarketParamsIdDeterministic(
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    ) public pure {
        MarketParams memory a = MarketParams({
            loanToken: loanToken,
            collateralToken: collateralToken,
            oracle: oracle,
            irm: irm,
            lltv: lltv
        });
        MarketParams memory b = MarketParams({
            loanToken: loanToken,
            collateralToken: collateralToken,
            oracle: oracle,
            irm: irm,
            lltv: lltv
        });
        require(Id.unwrap(a.id()) == Id.unwrap(b.id()), "id: deterministic");
    }

    function testFuzz_MarketParamsIdDiffersWhenLoanTokenDiffers(
        address loanA,
        address loanB,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    ) public pure {
        if (loanA == loanB) return;
        Id idA = MarketParams(loanA, collateralToken, oracle, irm, lltv).id();
        Id idB = MarketParams(loanB, collateralToken, oracle, irm, lltv).id();
        require(Id.unwrap(idA) != Id.unwrap(idB), "id: loanToken");
    }

    function testFuzz_MarketParamsIdDiffersWhenCollateralTokenDiffers(
        address loanToken,
        address collA,
        address collB,
        address oracle,
        address irm,
        uint256 lltv
    ) public pure {
        if (collA == collB) return;
        Id idA = MarketParams(loanToken, collA, oracle, irm, lltv).id();
        Id idB = MarketParams(loanToken, collB, oracle, irm, lltv).id();
        require(Id.unwrap(idA) != Id.unwrap(idB), "id: collateralToken");
    }

    function testFuzz_MarketParamsIdDiffersWhenOracleDiffers(
        address loanToken,
        address collateralToken,
        address oracleA,
        address oracleB,
        address irm,
        uint256 lltv
    ) public pure {
        if (oracleA == oracleB) return;
        Id idA = MarketParams(loanToken, collateralToken, oracleA, irm, lltv).id();
        Id idB = MarketParams(loanToken, collateralToken, oracleB, irm, lltv).id();
        require(Id.unwrap(idA) != Id.unwrap(idB), "id: oracle");
    }

    function testFuzz_MarketParamsIdDiffersWhenIrmDiffers(
        address loanToken,
        address collateralToken,
        address oracle,
        address irmA,
        address irmB,
        uint256 lltv
    ) public pure {
        if (irmA == irmB) return;
        Id idA = MarketParams(loanToken, collateralToken, oracle, irmA, lltv).id();
        Id idB = MarketParams(loanToken, collateralToken, oracle, irmB, lltv).id();
        require(Id.unwrap(idA) != Id.unwrap(idB), "id: irm");
    }

    function testFuzz_MarketParamsIdDiffersWhenLltvDiffers(
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltvA,
        uint256 lltvB
    ) public pure {
        if (lltvA == lltvB) return;
        Id idA = MarketParams(loanToken, collateralToken, oracle, irm, lltvA).id();
        Id idB = MarketParams(loanToken, collateralToken, oracle, irm, lltvB).id();
        require(Id.unwrap(idA) != Id.unwrap(idB), "id: lltv");
    }

    // --- Rounding order (down <= up, same inputs) ---

    function testFuzz_ToSharesDownLeToSharesUp(uint256 assets, uint256 totalAssets, uint256 totalShares) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 down = assets.toSharesDown(totalAssets, totalShares);
        uint256 up = assets.toSharesUp(totalAssets, totalShares);
        require(down <= up, "shares: down <= up");
    }

    function testFuzz_ToAssetsDownLeToAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) public pure {
        if (shares > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 down = shares.toAssetsDown(totalAssets, totalShares);
        uint256 up = shares.toAssetsUp(totalAssets, totalShares);
        require(down <= up, "assets: down <= up");
    }

    /// @notice Floor vs ceil on the same mulDiv differ by at most one asset unit.
    /// @dev This is the atomic “≤1 wei in the assets domain” step; composed ERC-4626 + Morpho paths can stack larger
    ///      residuals in raw `supplyShares` (see `MORPHO_SHARES_DUST` in `MorphoBlueSupplyVault` fork tests).
    function testFuzz_AssetsUpMinusAssetsDownAtMostOne(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (shares > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 d = shares.toAssetsDown(totalAssets, totalShares);
        uint256 u = shares.toAssetsUp(totalAssets, totalShares);
        require(u - d <= 1, "assets: up-down <= 1");
    }

    /// @notice Floor vs ceil on the same mulDiv differ by at most one share unit.
    /// @dev Atomic “≤1 wei in the shares domain” step; not to be confused with fork-test `MORPHO_SHARES_DUST`.
    function testFuzz_SharesUpMinusSharesDownAtMostOne(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 d = assets.toSharesDown(totalAssets, totalShares);
        uint256 u = assets.toSharesUp(totalAssets, totalShares);
        require(u - d <= 1, "shares: up-down <= 1");
    }

    // --- Dust: same-direction iteration (library-level; integration dust is larger) ---

    /// @notice Three floor steps at fixed pool state do not increase the quoted asset amount (`a2 <= a1`).
    /// @dev Follows from `toSharesDown(toAssetsDown(shares)) <= shares` and monotonicity of `toAssetsDown` in shares.
    function testFuzz_TripleFloorChain_AssetsQuotedDoesNotIncrease(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (shares > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 a1 = shares.toAssetsDown(totalAssets, totalShares);
        uint256 s1 = a1.toSharesDown(totalAssets, totalShares);
        uint256 a2 = s1.toAssetsDown(totalAssets, totalShares);
        require(a2 <= a1, "triple floor: a2 <= a1");
    }

    /// @notice Three ceil steps at fixed pool state do not decrease the quoted share amount (`s2 >= s1`).
    /// @dev Follows from `toAssetsUp(toSharesUp(assets)) >= assets` and monotonicity of `toSharesUp` in assets.
    function testFuzz_TripleCeilChain_SharesQuotedDoesNotDecrease(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 s1 = assets.toSharesUp(totalAssets, totalShares);
        uint256 a1 = s1.toAssetsUp(totalAssets, totalShares);
        uint256 s2 = a1.toSharesUp(totalAssets, totalShares);
        require(s2 >= s1, "triple ceil: s2 >= s1");
    }

    /// @notice Alternating down chain: `assets → shares↓ → assets↓ → shares↓` is non-increasing at each coordinate,
    ///         and each leg’s floor-vs-ceil gap is at most one unit in that leg’s domain (cross-step bounded drift).
    /// @dev Composes `testFuzz_SharesMathAssetsToSharesToAssetsDown`, share-domain `toSharesDown∘toAssetsDown`, and
    ///      the two `*UpMinus*DownAtMostOne` lemmas on `assets`, `s1`, and `a1`.
    function testFuzz_AlternatingDownChain_FourSteps_NonIncreasingAndBoundedPerLeg(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 s1 = assets.toSharesDown(totalAssets, totalShares);
        uint256 a1 = s1.toAssetsDown(totalAssets, totalShares);
        uint256 s2 = a1.toSharesDown(totalAssets, totalShares);

        require(a1 <= assets, "alt down: assets non-increasing");
        require(s2 <= s1, "alt down: shares non-increasing");

        require(assets.toSharesUp(totalAssets, totalShares) - s1 <= 1, "alt down: leg1 shares up-down");
        require(s1.toAssetsUp(totalAssets, totalShares) - a1 <= 1, "alt down: leg2 assets up-down");
        require(a1.toSharesUp(totalAssets, totalShares) - s2 <= 1, "alt down: leg3 shares up-down");
    }

    // --- Monotonicity in shares (down path) ---

    function testFuzz_SharesMathToAssetsDownMonotonicInShares(
        uint256 sharesLo,
        uint256 sharesHi,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (sharesLo > sharesHi) return;
        if (sharesHi > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 aLo = sharesLo.toAssetsDown(totalAssets, totalShares);
        uint256 aHi = sharesHi.toAssetsDown(totalAssets, totalShares);
        require(aLo <= aHi, "monotonic: assets vs shares (down)");
    }

    function testFuzz_SharesMathToAssetsUpMonotonicInShares(
        uint256 sharesLo,
        uint256 sharesHi,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (sharesLo > sharesHi) return;
        if (sharesHi > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 aLo = sharesLo.toAssetsUp(totalAssets, totalShares);
        uint256 aHi = sharesHi.toAssetsUp(totalAssets, totalShares);
        require(aLo <= aHi, "monotonic: assets vs shares (up)");
    }

    // --- Monotonicity in assets (down / up share conversion) ---

    function testFuzz_SharesMathToSharesDownMonotonicInAssets(
        uint256 assetsLo,
        uint256 assetsHi,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assetsLo > assetsHi) return;
        if (assetsHi > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;

        uint256 sLo = assetsLo.toSharesDown(totalAssets, totalShares);
        uint256 sHi = assetsHi.toSharesDown(totalAssets, totalShares);
        require(sLo <= sHi, "monotonic: shares vs assets (down)");
    }

    function testFuzz_SharesMathToSharesUpMonotonicInAssets(
        uint256 assetsLo,
        uint256 assetsHi,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assetsLo > assetsHi) return;
        if (assetsHi > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 sLo = assetsLo.toSharesUp(totalAssets, totalShares);
        uint256 sHi = assetsHi.toSharesUp(totalAssets, totalShares);
        require(sLo <= sHi, "monotonic: shares vs assets (up)");
    }

    // --- Fresh market (zero totals): virtual liquidity rate & exact round-trip ---

    function testFuzz_FreshMarket_ToSharesDownScalesByVirtualShares(uint256 assets) public pure {
        if (assets == 0) return;
        // (assets * 1e6) must not overflow; keep headroom for fuzz harness
        if (assets > type(uint256).max / _VIRTUAL_SHARES) return;

        uint256 shares = assets.toSharesDown(0, 0);
        uint256 expected = (assets * _VIRTUAL_SHARES) / _VIRTUAL_ASSETS;
        require(shares == expected, "fresh: toSharesDown matches virtual rate");
    }

    function testFuzz_FreshMarket_ToAssetsDownDividesByVirtualShares(uint256 shares) public pure {
        if (shares > 1e30) return;

        uint256 a = shares.toAssetsDown(0, 0);
        uint256 expected = (shares * _VIRTUAL_ASSETS) / (_VIRTUAL_SHARES);
        require(a == expected, "fresh: toAssetsDown divides by virtual shares");
    }

    function testFuzz_FreshMarket_AssetsRoundTripExact(uint256 assets) public pure {
        if (assets == 0) return;
        if (assets > type(uint256).max / _VIRTUAL_SHARES) return;

        uint256 sh = assets.toSharesDown(0, 0);
        uint256 back = sh.toAssetsDown(0, 0);
        require(back == assets, "fresh: round-trip exact");
    }

    // --- Round-trip & dust (non-empty market) ---

    function testFuzz_SharesMathAssetsToSharesToAssetsDown(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;

        uint256 shares = assets.toSharesDown(totalAssets, totalShares);
        uint256 assetsBack = shares.toAssetsDown(totalAssets, totalShares);
        require(assetsBack <= assets, "round-trip: assetsBack <= assets");
    }

    /// @notice Asset-domain: ceil shares then ceil assets recovers at least `assets` (same-direction rounding chain).
    /// @dev Alternating down/up sandwiches (e.g. `toSharesDown` then `toAssetsUp`) are not universal invariants here:
    ///      virtual `A'`/`S'` and integer `mulDiv` can break them even away from zero-dust inputs; see
    ///      `testFuzz_ToSharesUpGeToSharesDownSameAssets` for the related up-then-down asymmetry on assets.
    function testFuzz_SharesMathAssetsToSharesUpToAssetsUp(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 shares = assets.toSharesUp(totalAssets, totalShares);
        uint256 assetsBack = shares.toAssetsUp(totalAssets, totalShares);
        require(assetsBack >= assets, "round-trip up then up: assetsBack >= assets");
    }

    /// @notice Share-domain: floor assets then floor shares never exceeds `shares` (same-direction rounding chain).
    function testFuzz_SharesMathSharesToAssetsDownToSharesDown(
        uint256 shares,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (shares > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 assets = shares.toAssetsDown(totalAssets, totalShares);
        uint256 sharesBack = assets.toSharesDown(totalAssets, totalShares);
        require(sharesBack <= shares, "round-trip down then down: sharesBack <= shares");
    }

    /// @notice Zero amount in any conversion direction yields zero (regression guard).
    function testFuzz_ZeroAmountIdentities(uint256 totalAssets, uint256 totalShares) public pure {
        if (totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        require(uint256(0).toSharesDown(totalAssets, totalShares) == 0, "0 toSharesDown");
        require(uint256(0).toSharesUp(totalAssets, totalShares) == 0, "0 toSharesUp");
        require(uint256(0).toAssetsDown(totalAssets, totalShares) == 0, "0 toAssetsDown");
        require(uint256(0).toAssetsUp(totalAssets, totalShares) == 0, "0 toAssetsUp");
    }

    /// @notice For the same `assets`, ceil-minted shares are >= floor-minted shares (rounding order).
    /// @dev Do not assert `toAssetsDown(toSharesUp(assets)) <= assets`: up-then-down can exceed `assets` when the
    ///      pool ratio makes the extra shares from rounding up convert back to more assets under floor division.
    function testFuzz_ToSharesUpGeToSharesDownSameAssets(
        uint256 assets,
        uint256 totalAssets,
        uint256 totalShares
    ) public pure {
        if (assets > 1e30 || totalAssets > 1e30 || totalShares > 1e30) return;
        if (totalAssets >= type(uint256).max - _VIRTUAL_ASSETS) return;
        if (totalShares >= type(uint256).max - _VIRTUAL_SHARES) return;

        uint256 up = assets.toSharesUp(totalAssets, totalShares);
        uint256 down = assets.toSharesDown(totalAssets, totalShares);
        require(up >= down, "shares: up >= down for same assets");
    }
}
