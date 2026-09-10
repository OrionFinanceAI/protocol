/**
 * UniswapV3PoolPriceAdapter unit tests.
 */

import { expect } from "chai";
import { ethers } from "./helpers/hh";
import type { MockUnderlyingAsset, MockOrionConfig, UniswapV3PoolPriceAdapter } from "../typechain-types";

const TWAP = 300;
const SQRT_OK = 1n << 96n; // ~1.0 price

describe("UniswapV3PoolPriceAdapter — unit tests", function () {
  let config: MockOrionConfig;
  let usdc: MockUnderlyingAsset;
  let asset: MockUnderlyingAsset;
  let adapter: UniswapV3PoolPriceAdapter;

  async function deployPool(
    token0: string,
    token1: string,
    sqrt: bigint = SQRT_OK,
    liquidity: bigint = 1_000_000n,
    cardinality: number = 10,
    observeReverts = false,
  ) {
    const PoolF = await ethers.getContractFactory("MockUniswapV3PoolForPriceAdapter");
    const pool = await PoolF.deploy(token0, token1, sqrt, liquidity, cardinality, observeReverts);
    await pool.waitForDeployment();
    return pool;
  }

  beforeEach(async function () {
    const TokenF = await ethers.getContractFactory("MockUnderlyingAsset");
    usdc = (await TokenF.deploy(6)) as unknown as MockUnderlyingAsset;
    asset = (await TokenF.deploy(18)) as unknown as MockUnderlyingAsset;
    await usdc.waitForDeployment();
    await asset.waitForDeployment();

    const ConfigF = await ethers.getContractFactory("MockOrionConfig");
    config = (await ConfigF.deploy(await usdc.getAddress())) as unknown as MockOrionConfig;
    await config.waitForDeployment();

    const AdapterF = await ethers.getContractFactory("UniswapV3PoolPriceAdapter");
    adapter = (await AdapterF.deploy(
      await config.getAddress(),
      await usdc.getAddress(),
      TWAP,
      0, // min liquidity skip
      0, // min cardinality skip
      0, // max staleness skip
    )) as unknown as UniswapV3PoolPriceAdapter;
    await adapter.waitForDeployment();
  });

  describe("constructor", function () {
    it("should reject zero USDC", async function () {
      const AdapterF = await ethers.getContractFactory("UniswapV3PoolPriceAdapter");
      await expect(
        AdapterF.deploy(await config.getAddress(), ethers.ZeroAddress, TWAP, 0, 0, 0),
      ).to.be.revertedWithCustomError(adapter, "ZeroAddress");
    });

    it("should reject TWAP window below minimum", async function () {
      const AdapterF = await ethers.getContractFactory("UniswapV3PoolPriceAdapter");
      await expect(
        AdapterF.deploy(await config.getAddress(), await usdc.getAddress(), 1, 0, 0, 0),
      ).to.be.revertedWithCustomError(adapter, "InvalidArguments");
    });
  });

  describe("setPool", function () {
    it("should reject zero asset or pool", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await expect(adapter.setPool(ethers.ZeroAddress, await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "ZeroAddress",
      );
      await expect(adapter.setPool(await asset.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
        adapter,
        "ZeroAddress",
      );
    });

    it("should reject USDC as the priced asset", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await expect(adapter.setPool(await usdc.getAddress(), await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "InvalidAdapter",
      );
    });

    it("should reject pool whose token0 call reverts", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await pool.setTokenReverts(true, false);
      await expect(adapter.setPool(await asset.getAddress(), await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "InvalidAdapter",
      );
    });

    it("should reject pool whose token1 call reverts", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await pool.setTokenReverts(false, true);
      await expect(adapter.setPool(await asset.getAddress(), await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "InvalidAdapter",
      );
    });

    it("should reject invalid token pair", async function () {
      const other = (await (await ethers.getContractFactory("MockUnderlyingAsset")).deploy(18)) as MockUnderlyingAsset;
      const pool = await deployPool(await other.getAddress(), await asset.getAddress());
      await expect(adapter.setPool(await asset.getAddress(), await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "InvalidAdapter",
      );
    });

    it("should reject uninitialized pool (sqrt=0)", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress(), 0n);
      await expect(adapter.setPool(await asset.getAddress(), await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "PoolNotInitialized",
      );
    });

    it("should reject when observe reverts (TwapUnavailable)", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress(), SQRT_OK, 1_000_000n, 10, true);
      await expect(adapter.setPool(await asset.getAddress(), await pool.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "TwapUnavailable",
      );
    });

    it("should register a valid pool", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await expect(adapter.setPool(await asset.getAddress(), await pool.getAddress()))
        .to.emit(adapter, "PoolSet")
        .withArgs(await asset.getAddress(), await pool.getAddress());
      expect(await adapter.poolOf(await asset.getAddress())).to.equal(await pool.getAddress());
    });
  });

  describe("validatePriceAdapter / getPriceData", function () {
    it("should reject unconfigured asset on validate", async function () {
      await expect(adapter.validatePriceAdapter(await asset.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "InvalidAdapter",
      );
    });

    it("should reject unconfigured asset on getPriceData", async function () {
      await expect(adapter.getPriceData(await asset.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "InvalidAdapter",
      );
    });

    it("should return a positive price for a configured pool", async function () {
      const pool = await deployPool(await asset.getAddress(), await usdc.getAddress()); // USDC token1
      await adapter.setPool(await asset.getAddress(), await pool.getAddress());
      const [price, decimals] = await adapter.getPriceData(await asset.getAddress());
      expect(price).to.be.gt(0n);
      expect(decimals).to.equal(16); // PRICE_DECIMALS(10) + USDC(6)
    });

    it("should reject when slot0 sqrt becomes zero after setPool", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await adapter.setPool(await asset.getAddress(), await pool.getAddress());
      await pool.setSqrtPriceX96(0n);
      await expect(adapter.getPriceData(await asset.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "PoolNotInitialized",
      );
    });

    it("should reject stale observations when staleness is configured", async function () {
      const AdapterF = await ethers.getContractFactory("UniswapV3PoolPriceAdapter");
      const staleAdapter = (await AdapterF.deploy(
        await config.getAddress(),
        await usdc.getAddress(),
        TWAP,
        0,
        0,
        60, // max observation age 60s
      )) as unknown as UniswapV3PoolPriceAdapter;

      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await staleAdapter.setPool(await asset.getAddress(), await pool.getAddress());

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await pool.configureObservation(now - 120, true, 0);
      await expect(staleAdapter.getPriceData(await asset.getAddress())).to.be.revertedWithCustomError(
        staleAdapter,
        "OracleStale",
      );
    });

    it("should reject observe length mismatch as TwapUnavailable", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await adapter.setPool(await asset.getAddress(), await pool.getAddress());
      await pool.setObserveLengthMismatch(true);
      await expect(adapter.getPriceData(await asset.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "TwapUnavailable",
      );
    });

    it("should price when TWAP tick delta is negative with non-zero remainder", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      // delta = newer - older = -301; window=300 → floor division + negative remainder adjust
      await pool.setObserveCumulatives(301n, 0n);
      await adapter.setPool(await asset.getAddress(), await pool.getAddress());
      const [price] = await adapter.getPriceData(await asset.getAddress());
      expect(price).to.be.gt(0n);
    });

    it("should revert TickOutOfBounds for extreme TWAP mean tick", async function () {
      const pool = await deployPool(await usdc.getAddress(), await asset.getAddress());
      await adapter.setPool(await asset.getAddress(), await pool.getAddress());
      // avgTick = delta/window must exceed int24.max (8388607); window=300
      const huge = 8388608n * 300n;
      await pool.setObserveCumulatives(0n, huge);
      await expect(adapter.getPriceData(await asset.getAddress())).to.be.revertedWithCustomError(
        adapter,
        "TickOutOfBounds",
      );
    });
  });
});
