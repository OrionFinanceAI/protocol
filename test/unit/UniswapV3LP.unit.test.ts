/**
 * UniswapV3LP Unit Tests — no mainnet fork required.
 *
 * Tests:
 *   1. UniswapV3LPWrapper share math (deposit / withdraw with MockNPM)
 *   2. UniswapV3LPPriceAdapter price computation (with MockPool, MockWrapper, MockRegistry)
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  UniswapV3LPWrapper,
  UniswapV3LPPriceAdapter,
  MockUnderlyingAsset,
  MockUniswapV3NonfungiblePositionManager,
  MockUniswapV3Pool,
  MockOrionConfig,
  MockPriceAdapterRegistry,
  MockPriceAdapter,
  MockUniswapV3Factory,
} from "../../typechain-types";

// ─── TickMath (TypeScript implementation) ────────────────────────────────────
// Needed to compute sqrtRatioAtTick for wrapper constructor parameters.
// Translated directly from Uniswap V3-core TickMath.sol.

function getSqrtRatioAtTick(tick: number): bigint {
  const MAX_TICK = 887272;
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error(`Tick ${tick} out of range`);
  const a = BigInt(absTick);

  let ratio =
    (a & 1n) !== 0n ? BigInt("0xfffcb933bd6fad37aa2d162d1a594001") : BigInt("0x100000000000000000000000000000000");

  const steps: Array<[bigint, bigint]> = [
    [0x2n, BigInt("0xfff97272373d413259a46990580e213a")],
    [0x4n, BigInt("0xfff2e50f5f656932ef12357cf3c7fdcc")],
    [0x8n, BigInt("0xffe5caca7e10e4e61c3624eaa0941cd0")],
    [0x10n, BigInt("0xffcb9843d60f6159c9db58835c926644")],
    [0x20n, BigInt("0xff973b41fa98c081472e6896dfb254c0")],
    [0x40n, BigInt("0xff2ea16466c96a3843ec78b326b52861")],
    [0x80n, BigInt("0xfe5dee046a99a2a811c461f1969c3053")],
    [0x100n, BigInt("0xfcbe86c7900a88aedcffc83b479aa3a4")],
    [0x200n, BigInt("0xf987a7253ac413176f2b074cf7815e54")],
    [0x400n, BigInt("0xf3392b0822b70005940c7a398e4b70f3")],
    [0x800n, BigInt("0xe7159475a2c29b7443b29c7fa6e889d9")],
    [0x1000n, BigInt("0xd097f3bdfd2022b8845ad8f792aa5825")],
    [0x2000n, BigInt("0xa9f746462d870fdf8a65dc1f90e061e5")],
    [0x4000n, BigInt("0x70d869a156d2a1b890bb3df62baf32f7")],
    [0x8000n, BigInt("0x31be135f97d08fd981231505542fcfa6")],
    [0x10000n, BigInt("0x9aa508b5b7a84e1c677de54f3e99bc9")],
    [0x20000n, BigInt("0x5d6af8dedb81196699c329225ee604")],
    [0x40000n, BigInt("0x2216e584f5fa1ea926041bedfe98")],
    [0x80000n, BigInt("0x48a170391f7dc42444e8fa2")],
  ];

  for (const [mask, val] of steps) {
    if ((a & mask) !== 0n) ratio = (ratio * val) >> 128n;
  }

  if (tick > 0) {
    const MAX_U256 = (1n << 256n) - 1n;
    ratio = MAX_U256 / ratio;
  }

  const sqrtPriceX96 = (ratio >> 32n) + (ratio % (1n << 32n) > 0n ? 1n : 0n);
  return sqrtPriceX96;
}

// ─── Test constants ───────────────────────────────────────────────────────────

const TICK_LOWER = -10; // narrow symmetric range around 0 (price ≈ 1.0)
const TICK_UPPER = 10;
const SQRT_RATIO_LOWER = getSqrtRatioAtTick(TICK_LOWER);
const SQRT_RATIO_UPPER = getSqrtRatioAtTick(TICK_UPPER);
const FEE = 3000;
const PRICE_DECIMALS = 10; // matches UniswapV3LPPriceAdapter.PRICE_DECIMALS
const PAD = 14; // MockOrionConfig.priceAdapterDecimals = 14

// sqrtPriceX96 for price = 1.0 (i.e. token1/token0 = 1), at Q96 precision: sqrt(1) * 2^96 = 2^96
const Q96 = 1n << 96n;

describe("UniswapV3LP — Unit Tests (no fork)", function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  let tokenA: MockUnderlyingAsset;
  let tokenB: MockUnderlyingAsset;
  let mockNPM: MockUniswapV3NonfungiblePositionManager;
  let mockPool: MockUniswapV3Pool;
  let mockFactory: MockUniswapV3Factory;
  let mockConfig: MockOrionConfig;
  let priceRegistry: MockPriceAdapterRegistry;
  let priceAdapter: MockPriceAdapter;

  before(async function () {
    [owner, alice] = await ethers.getSigners();

    // Two 18-decimal ERC20 tokens (sorted so tokenA < tokenB by address)
    const ERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
    const t1 = (await ERC20.deploy(18)) as unknown as MockUnderlyingAsset;
    const t2 = (await ERC20.deploy(18)) as unknown as MockUnderlyingAsset;

    // Sort so token0 < token1 (matches Uniswap convention)
    const [a, b] = (await t1.getAddress()).toLowerCase() < (await t2.getAddress()).toLowerCase() ? [t1, t2] : [t2, t1];
    tokenA = a;
    tokenB = b;

    // Mock pool at price = 1.0
    const PoolFactory = await ethers.getContractFactory("MockUniswapV3Pool");
    mockPool = (await PoolFactory.deploy(Q96, 0)) as unknown as MockUniswapV3Pool;

    // Mock factory
    const FactoryF = await ethers.getContractFactory("MockUniswapV3Factory");
    mockFactory = (await FactoryF.deploy()) as unknown as MockUniswapV3Factory;
    await mockFactory.setPool(await tokenA.getAddress(), await tokenB.getAddress(), FEE, await mockPool.getAddress());

    // Mock NPM
    const NPMFactory = await ethers.getContractFactory("MockUniswapV3NonfungiblePositionManager");
    mockNPM = (await NPMFactory.deploy()) as unknown as MockUniswapV3NonfungiblePositionManager;

    // Mock config (underlying = tokenA for simplicity, 18 decimals)
    const ConfigF = await ethers.getContractFactory("MockOrionConfig");
    mockConfig = (await ConfigF.deploy(await tokenA.getAddress())) as unknown as MockOrionConfig;

    // Price registry + adapter
    const RegF = await ethers.getContractFactory("MockPriceAdapterRegistry");
    priceRegistry = (await RegF.deploy()) as unknown as MockPriceAdapterRegistry;
    await mockConfig.setPriceAdapterRegistry(await priceRegistry.getAddress());

    const PAdF = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await PAdF.deploy()) as unknown as MockPriceAdapter;
    // Set price of tokenA = 1e14 and tokenB = 4000e14 (in priceAdapterDecimals=14)
    await priceAdapter.setMockPrice(await tokenA.getAddress(), ethers.parseUnits("1", PAD));
    await priceAdapter.setMockPrice(await tokenB.getAddress(), ethers.parseUnits("4000", PAD));
    await priceRegistry.setPriceAdapter(await tokenA.getAddress(), await priceAdapter.getAddress());
    await priceRegistry.setPriceAdapter(await tokenB.getAddress(), await priceAdapter.getAddress());

    // Whitelist tokens in config
    await mockConfig.setWhitelisted(await tokenA.getAddress(), true);
    await mockConfig.setWhitelisted(await tokenB.getAddress(), true);
  });

  // ─── Helper to deploy a fresh wrapper ──────────────────────────────────────

  async function deployWrapper(executionAdapter: string): Promise<UniswapV3LPWrapper> {
    const WrapperF = await ethers.getContractFactory("UniswapV3LPWrapper");
    return (await WrapperF.deploy(
      owner.address,
      await mockNPM.getAddress(),
      await mockPool.getAddress(),
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      FEE,
      TICK_LOWER,
      TICK_UPPER,
      SQRT_RATIO_LOWER,
      SQRT_RATIO_UPPER,
      executionAdapter,
      "Test LP Shares",
      "TLP",
    )) as unknown as UniswapV3LPWrapper;
  }

  // ─── Share math tests ─────────────────────────────────────────────────────

  describe("UniswapV3LPWrapper — share math", function () {
    let wrapper: UniswapV3LPWrapper;

    before(async function () {
      // Use owner as the execution adapter (simplifies test calls)
      wrapper = await deployWrapper(owner.address);
    });

    it("constructor: immutables are set correctly", async function () {
      expect(await wrapper.TOKEN0()).to.equal(await tokenA.getAddress());
      expect(await wrapper.TOKEN1()).to.equal(await tokenB.getAddress());
      expect(await wrapper.FEE()).to.equal(FEE);
      expect(await wrapper.TICK_LOWER()).to.equal(TICK_LOWER);
      expect(await wrapper.TICK_UPPER()).to.equal(TICK_UPPER);
      expect(await wrapper.SQRT_RATIO_LOWER_X96()).to.equal(SQRT_RATIO_LOWER);
      expect(await wrapper.SQRT_RATIO_UPPER_X96()).to.equal(SQRT_RATIO_UPPER);
      expect(await wrapper.tokenId()).to.equal(0n);
    });

    it("first depositLiquidity: shares = liquidity (1:1)", async function () {
      const LIQUIDITY = 1_000n;

      await mockNPM.setNextLiquidityReturn(LIQUIDITY);
      await tokenA.mint(owner.address, LIQUIDITY);
      await tokenB.mint(owner.address, LIQUIDITY);

      await tokenA.connect(owner).approve(await wrapper.getAddress(), LIQUIDITY);
      await tokenB.connect(owner).approve(await wrapper.getAddress(), LIQUIDITY);

      await wrapper.connect(owner).depositLiquidity(LIQUIDITY, LIQUIDITY, alice.address, LIQUIDITY);

      expect(await wrapper.totalSupply()).to.equal(LIQUIDITY);
      expect(await wrapper.totalLiquidity()).to.equal(LIQUIDITY);
      expect(await wrapper.tokenId()).to.equal(1n);
      expect(await wrapper.balanceOf(alice.address)).to.equal(LIQUIDITY);
    });

    it("second depositLiquidity: shares proportional to existing ratio", async function () {
      const LIQUIDITY2 = 500n;
      const supplyBefore = await wrapper.totalSupply(); // 1000
      const liqBefore = await wrapper.totalLiquidity(); // 1000

      await mockNPM.setNextLiquidityReturn(LIQUIDITY2);
      await tokenA.mint(owner.address, LIQUIDITY2);
      await tokenB.mint(owner.address, LIQUIDITY2);
      await tokenA.connect(owner).approve(await wrapper.getAddress(), LIQUIDITY2);
      await tokenB.connect(owner).approve(await wrapper.getAddress(), LIQUIDITY2);

      await wrapper.connect(owner).depositLiquidity(LIQUIDITY2, LIQUIDITY2, alice.address, 500n);

      const expectedShares = (LIQUIDITY2 * supplyBefore) / liqBefore; // 500 * 1000 / 1000 = 500
      expect(await wrapper.balanceOf(alice.address)).to.equal(supplyBefore + expectedShares);
      expect(await wrapper.totalLiquidity()).to.equal(liqBefore + LIQUIDITY2);
    });

    it("withdrawLiquidity: burns proportional shares and returns tokens", async function () {
      const totalShares = await wrapper.totalSupply(); // 1500
      const totalLiq = await wrapper.totalLiquidity(); // 1500
      const sharesToBurn = 750n;

      const expectedLiq = (sharesToBurn * totalLiq) / totalShares; // 750

      const aliceBalA_before = await tokenA.balanceOf(alice.address);
      const aliceBalB_before = await tokenB.balanceOf(alice.address);

      // Transfer shares to owner (adapter = owner)
      await wrapper.connect(alice).transfer(owner.address, sharesToBurn);

      await wrapper.connect(owner).withdrawLiquidity(sharesToBurn, alice.address);

      // Shares burned
      expect(await wrapper.balanceOf(owner.address)).to.equal(0n);
      expect(await wrapper.totalSupply()).to.equal(totalShares - sharesToBurn);

      // Tokens received (mock NPM: amount0 = amount1 = liquidity)
      expect(await tokenA.balanceOf(alice.address)).to.equal(aliceBalA_before + expectedLiq);
      expect(await tokenB.balanceOf(alice.address)).to.equal(aliceBalB_before + expectedLiq);
    });

    it("full withdrawal: burns the NFT and resets tokenId to 0", async function () {
      const remaining = await wrapper.totalSupply();
      await wrapper.connect(alice).transfer(owner.address, remaining);
      await wrapper.connect(owner).withdrawLiquidity(remaining, alice.address);

      expect(await wrapper.totalSupply()).to.equal(0n);
      expect(await wrapper.tokenId()).to.equal(0n);
    });

    it("onlyAdapter: reverts when caller is not execution adapter", async function () {
      await expect(
        wrapper.connect(alice).depositLiquidity(100n, 100n, alice.address, 0n),
      ).to.be.revertedWithCustomError(wrapper, "NotAuthorized");

      await expect(wrapper.connect(alice).withdrawLiquidity(1n, alice.address)).to.be.revertedWithCustomError(
        wrapper,
        "NotAuthorized",
      );
    });

    it("depositLiquidity: reverts when minted shares below minSharesOut", async function () {
      const w = await deployWrapper(owner.address);
      await mockNPM.setNextLiquidityReturn(100n);
      await tokenA.mint(owner.address, 1000n);
      await tokenB.mint(owner.address, 1000n);
      await tokenA.connect(owner).approve(await w.getAddress(), 1000n);
      await tokenB.connect(owner).approve(await w.getAddress(), 1000n);

      await expect(w.connect(owner).depositLiquidity(1000n, 1000n, alice.address, 500n)).to.be.revertedWithCustomError(
        w,
        "LPShareMintBelowMinimum",
      );
    });

    it("unused tokens are returned to adapter after deposit", async function () {
      // NPM will consume only 500 of the 1000 tokens provided
      const DESIRED = 1000n;
      const LIQUIDITY = 500n; // NPM uses only half

      // Fresh wrapper so state is clean
      const freshWrapper = await deployWrapper(owner.address);

      await mockNPM.setNextLiquidityReturn(LIQUIDITY);
      await tokenA.mint(owner.address, DESIRED);
      await tokenB.mint(owner.address, DESIRED);
      await tokenA.connect(owner).approve(await freshWrapper.getAddress(), DESIRED);
      await tokenB.connect(owner).approve(await freshWrapper.getAddress(), DESIRED);

      const ownerBalA_before = await tokenA.balanceOf(owner.address);
      const ownerBalB_before = await tokenB.balanceOf(owner.address);

      await freshWrapper.connect(owner).depositLiquidity(DESIRED, DESIRED, alice.address, LIQUIDITY);

      // Owner (adapter) should have received the 500 unused tokens back
      expect(await tokenA.balanceOf(owner.address)).to.equal(ownerBalA_before - DESIRED + (DESIRED - LIQUIDITY));
      expect(await tokenB.balanceOf(owner.address)).to.equal(ownerBalB_before - DESIRED + (DESIRED - LIQUIDITY));
      expect(await freshWrapper.totalSupply()).to.equal(LIQUIDITY);
    });
  });

  // ─── Price adapter tests ───────────────────────────────────────────────────

  describe("UniswapV3LPPriceAdapter — price computation", function () {
    let wrapper: UniswapV3LPWrapper;
    let priceAdapterContract: UniswapV3LPPriceAdapter;

    before(async function () {
      wrapper = await deployWrapper(owner.address);

      const PAFactory = await ethers.getContractFactory("UniswapV3LPPriceAdapter");
      priceAdapterContract = (await PAFactory.deploy(
        await mockConfig.getAddress(),
        await mockFactory.getAddress(),
      )) as unknown as UniswapV3LPPriceAdapter;
    });

    it("returns zero price when supply and liquidity are zero", async function () {
      const [price, decimals] = await priceAdapterContract.getPriceData(await wrapper.getAddress());
      expect(price).to.equal(0n);
      expect(decimals).to.equal(PRICE_DECIMALS + 18); // PRICE_DECIMALS=10 + underlyingDecimals=18
    });

    it("validatePriceAdapter: reverts when token not whitelisted", async function () {
      // Deploy wrapper with a non-whitelisted token
      const ERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
      const badToken = (await ERC20.deploy(18)) as unknown as MockUnderlyingAsset;
      const badPool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(Q96, 0);
      await mockFactory.setPool(
        await tokenA.getAddress(),
        await badToken.getAddress(),
        FEE,
        await badPool.getAddress(),
      );

      // Sort addresses
      const [tok0, tok1] =
        (await tokenA.getAddress()).toLowerCase() < (await badToken.getAddress()).toLowerCase()
          ? [tokenA, badToken]
          : [badToken, tokenA];

      const WrapperF = await ethers.getContractFactory("UniswapV3LPWrapper");
      const badWrapper = await WrapperF.deploy(
        owner.address,
        await mockNPM.getAddress(),
        await badPool.getAddress(),
        await tok0.getAddress(),
        await tok1.getAddress(),
        FEE,
        TICK_LOWER,
        TICK_UPPER,
        SQRT_RATIO_LOWER,
        SQRT_RATIO_UPPER,
        owner.address,
        "Bad",
        "BAD",
      );

      await expect(
        priceAdapterContract.validatePriceAdapter(await badWrapper.getAddress()),
      ).to.be.revertedWithCustomError(priceAdapterContract, "TokenNotWhitelisted");
    });

    it("getPriceData: price above range → all token1 (WETH-like)", async function () {
      // Set pool price above SQRT_RATIO_UPPER → position is all token1
      await mockPool.setSlot0((SQRT_RATIO_UPPER + 1n) as unknown as bigint, 20);

      // Give wrapper some liquidity via the mock NPM
      const LIQUIDITY = ethers.parseUnits("1", 18); // 1e18 liquidity units
      await mockNPM.setNextLiquidityReturn(LIQUIDITY as unknown as bigint);
      await tokenA.mint(owner.address, LIQUIDITY);
      await tokenB.mint(owner.address, LIQUIDITY);
      await tokenA.connect(owner).approve(await wrapper.getAddress(), LIQUIDITY);
      await tokenB.connect(owner).approve(await wrapper.getAddress(), LIQUIDITY);
      await wrapper.connect(owner).depositLiquidity(LIQUIDITY, LIQUIDITY, alice.address, LIQUIDITY);

      const totalSupply = await wrapper.totalSupply(); // = LIQUIDITY
      const totalLiq = await wrapper.totalLiquidity(); // = LIQUIDITY

      // When price is above range: getAmountsForLiquidity returns (0, amount1)
      // amount1 = liquidity * (sqrtRatioUpper - sqrtRatioLower) / Q96
      // For precision liquidity = totalLiq * 10^(10+18) / totalSupply = 10^28
      const precisionLiq = (totalLiq * BigInt(10 ** 28)) / totalSupply; // = 10^28
      const deltaQ = SQRT_RATIO_UPPER - SQRT_RATIO_LOWER;
      const expectedAmount1 = (precisionLiq * deltaQ) / Q96;

      // value1 = amount1 * 4000e14 / 1e18 * 1e18 / 1e14 (underlying=tokenA with 18 dec)
      // underlying decimals = 18, priceAdapterDecimals = 14
      const price1 = BigInt(ethers.parseUnits("4000", 14));
      const token1Decimals = 10n ** 18n;
      const scaleDivisor = 10n ** 14n;
      const underlyingScale = 10n ** 18n;
      const expectedValue = (((expectedAmount1 * price1) / token1Decimals) * underlyingScale) / scaleDivisor;

      const [price, decimals] = await priceAdapterContract.getPriceData(await wrapper.getAddress());
      expect(decimals).to.equal(PRICE_DECIMALS + 18); // 10 + 18 = 28

      // Allow 1% tolerance due to tick rounding in sqrt ratio
      const tolerance = expectedValue / 100n;
      expect(price).to.be.gte(expectedValue - tolerance);
      expect(price).to.be.lte(expectedValue + tolerance);
    });

    it("validatePriceAdapter: passes when pool exists and tokens are whitelisted", async function () {
      await expect(priceAdapterContract.validatePriceAdapter(await wrapper.getAddress())).to.not.be.reverted;
    });
  });
});
