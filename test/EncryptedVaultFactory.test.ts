import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  MockUnderlyingAsset,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  EncryptedVaultFactory,
} from "../typechain-types";

let encryptedVaultFactory: EncryptedVaultFactory;
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
  orionConfig = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
  await orionConfig.waitForDeployment();

  const EncryptedVaultFactoryFactory = await ethers.getContractFactory("EncryptedVaultFactory");
  encryptedVaultFactory = await EncryptedVaultFactoryFactory.deploy(await orionConfig.getAddress());
  await encryptedVaultFactory.waitForDeployment();

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
  await orionConfig.setVaultFactories(other.address, await encryptedVaultFactory.getAddress());
  await orionConfig.setPriceAdapterRegistry(await other.address);

  await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);
});

describe("EncryptedVaultFactory", function () {
  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await encryptedVaultFactory.config()).to.equal(await orionConfig.getAddress());
    });
  });
});
