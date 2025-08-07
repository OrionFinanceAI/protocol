import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  MockUnderlyingAsset,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
} from "../typechain-types";

let transparentVaultFactory: TransparentVaultFactory;
let orionConfig: OrionConfig;
let underlyingAsset: MockUnderlyingAsset;
let internalStatesOrchestrator: InternalStatesOrchestrator;
let liquidityOrchestrator: LiquidityOrchestrator;

let owner: SignerWithAddress, other: SignerWithAddress;

beforeEach(async function () {
  [owner, other] = await ethers.getSigners();

  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAsset.waitForDeployment();

  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  orionConfig = await OrionConfigFactory.deploy(owner.address);
  await orionConfig.waitForDeployment();

  const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
  transparentVaultFactory = await TransparentVaultFactoryFactory.deploy(await orionConfig.getAddress());
  await transparentVaultFactory.waitForDeployment();

  await orionConfig.setUnderlyingAsset(await underlyingAsset.getAddress());

  const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
  internalStatesOrchestrator = await InternalStatesOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await internalStatesOrchestrator.waitForDeployment();

  const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
  liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await liquidityOrchestrator.waitForDeployment();

  await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
  await orionConfig.setVaultFactories(await transparentVaultFactory.getAddress(), other.address);
  await orionConfig.setPriceAdapterRegistry(await other.address);

  await orionConfig.setProtocolParams(
    6, // curatorIntentDecimals
    18, // priceAdapterDecimals
    100, // encryptedMinibatchSize
  );
});

describe("TransparentVaultFactory", function () {
  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await transparentVaultFactory.config()).to.equal(await orionConfig.getAddress());
    });
  });
});
