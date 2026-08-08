import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "./helpers/hh";

import type {
  MockERC4626Asset,
  MockExecutionAdapter,
  MockUnderlyingAsset,
  MockPriceAdapter,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

describe("PriceAdapterRegistry", function () {
  let orionConfig: OrionConfig;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let underlyingAsset: MockUnderlyingAsset;
  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, automationRegistry] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner, undefined, automationRegistry);
    orionConfig = deployed.orionConfig;
    priceAdapterRegistry = deployed.priceAdapterRegistry;
    underlyingAsset = deployed.underlyingAsset;
  });

  describe("getPrice", function () {
    it("should revert with PriceMustBeGreaterThanZero when adapter returns zero for an asset", async function () {
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const mockAsset = (await MockERC4626AssetFactory.deploy(
        await underlyingAsset.getAddress(),
        "Broken Asset",
        "BA",
      )) as unknown as MockERC4626Asset;
      await mockAsset.waitForDeployment();

      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
      await priceAdapter.waitForDeployment();

      const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
      const mockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
      await mockExecutionAdapter.waitForDeployment();

      await orionConfig.addWhitelistedAsset(
        await mockAsset.getAddress(),
        await priceAdapter.getAddress(),
        await mockExecutionAdapter.getAddress(),
      );
      await priceAdapter.setForceZeroPrice(await mockAsset.getAddress(), true);

      await expect(priceAdapterRegistry.getPrice(await mockAsset.getAddress()))
        .to.be.revertedWithCustomError(priceAdapterRegistry, "PriceMustBeGreaterThanZero")
        .withArgs(await mockAsset.getAddress());
    });

    it("should return 1e14 for the underlying asset", async function () {
      const price = await priceAdapterRegistry.getPrice(await underlyingAsset.getAddress());
      expect(price).to.equal(10n ** 14n);
    });

    it("should revert AdapterNotSet for unknown asset", async function () {
      await expect(priceAdapterRegistry.getPrice(owner.address)).to.be.revertedWithCustomError(
        priceAdapterRegistry,
        "AdapterNotSet",
      );
    });
  });

  describe("setPriceAdapter access control", function () {
    it("should reject non-config caller", async function () {
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
      await expect(
        priceAdapterRegistry.setPriceAdapter(await underlyingAsset.getAddress(), await priceAdapter.getAddress()),
      ).to.be.revertedWithCustomError(priceAdapterRegistry, "NotAuthorized");
    });
  });

  describe("initialize", function () {
    it("should reject zero owner or config on initialize via proxy", async function () {
      const Impl = await ethers.getContractFactory("PriceAdapterRegistry");
      const impl = await Impl.deploy();
      await impl.waitForDeployment();

      const Proxy = await ethers.getContractFactory("OrionERC1967Proxy");
      const initBadOwner = Impl.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        await orionConfig.getAddress(),
      ]);
      await expect(Proxy.deploy(await impl.getAddress(), initBadOwner)).to.be.revertedWithCustomError(
        priceAdapterRegistry,
        "ZeroAddress",
      );

      const initBadConfig = Impl.interface.encodeFunctionData("initialize", [owner.address, ethers.ZeroAddress]);
      await expect(Proxy.deploy(await impl.getAddress(), initBadConfig)).to.be.revertedWithCustomError(
        priceAdapterRegistry,
        "ZeroAddress",
      );
    });
  });
});
