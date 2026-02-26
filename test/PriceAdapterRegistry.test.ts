import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";

import {
  MockERC4626Asset,
  MockExecutionAdapter,
  MockUnderlyingAsset,
  MockZeroPriceAdapter,
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

      const MockZeroPriceAdapterFactory = await ethers.getContractFactory("MockZeroPriceAdapter");
      const zeroPriceAdapter = (await MockZeroPriceAdapterFactory.deploy()) as unknown as MockZeroPriceAdapter;
      await zeroPriceAdapter.waitForDeployment();

      const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
      const mockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
      await mockExecutionAdapter.waitForDeployment();

      await orionConfig.addWhitelistedAsset(
        await mockAsset.getAddress(),
        await zeroPriceAdapter.getAddress(),
        await mockExecutionAdapter.getAddress(),
      );

      await expect(priceAdapterRegistry.getPrice(await mockAsset.getAddress()))
        .to.be.revertedWithCustomError(priceAdapterRegistry, "PriceMustBeGreaterThanZero")
        .withArgs(await mockAsset.getAddress());
    });
  });
});
