import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  TransparentVaultFactory,
  OrionTransparentVault,
} from "../typechain-types";

let transparentVaultFactory: TransparentVaultFactory;
let orionConfig: OrionConfig;
let underlyingAsset: MockUnderlyingAsset;
let mockAsset1: MockERC4626Asset;
let mockAsset2: MockERC4626Asset;
let mockPriceAdapter1: MockPriceAdapter;
let mockPriceAdapter2: MockPriceAdapter;
let mockExecutionAdapter1: MockExecutionAdapter;
let mockExecutionAdapter2: MockExecutionAdapter;
let transparentVault: OrionTransparentVault;

let owner: SignerWithAddress, strategist: SignerWithAddress, other: SignerWithAddress;

before(async function () {
  await resetNetwork();
});

beforeEach(async function () {
  [owner, strategist, other] = await ethers.getSigners();

  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAssetDeployed.waitForDeployment();
  underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

  const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
  const mockAsset1Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 1",
    "MA1",
  );
  await mockAsset1Deployed.waitForDeployment();
  mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

  const mockAsset2Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 2",
    "MA2",
  );
  await mockAsset2Deployed.waitForDeployment();
  mockAsset2 = mockAsset2Deployed as unknown as MockERC4626Asset;

  const deployed = await deployUpgradeableProtocol(owner, underlyingAsset);

  orionConfig = deployed.orionConfig;
  transparentVaultFactory = deployed.transparentVaultFactory;

  const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
  mockPriceAdapter1 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
  await mockPriceAdapter1.waitForDeployment();

  mockPriceAdapter2 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
  await mockPriceAdapter2.waitForDeployment();

  const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
  mockExecutionAdapter1 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
  await mockExecutionAdapter1.waitForDeployment();

  mockExecutionAdapter2 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
  await mockExecutionAdapter2.waitForDeployment();

  await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);

  await orionConfig.addWhitelistedAsset(
    await mockAsset1.getAddress(),
    await mockPriceAdapter1.getAddress(),
    await mockExecutionAdapter1.getAddress(),
  );
  await orionConfig.addWhitelistedAsset(
    await mockAsset2.getAddress(),
    await mockPriceAdapter2.getAddress(),
    await mockExecutionAdapter2.getAddress(),
  );
});

describe("TransparentVault - Strategist Pipeline", function () {
  describe("Vault Creation", function () {
    it("Should create a transparent vault with correct parameters", async function () {
      const tx = await transparentVaultFactory
        .connect(owner)
        .createVault(strategist.address, "Test Vault", "TV", 0, 0, 0, ethers.ZeroAddress);
      const receipt = await tx.wait();

      // Find the vault creation event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      void expect(event).to.not.be.undefined;
      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      void expect(vaultAddress).to.not.equal(ethers.ZeroAddress);

      // Get the vault contract
      transparentVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      // Verify vault properties
      void expect(await transparentVault.manager()).to.equal(owner.address);
      void expect(await transparentVault.strategist()).to.equal(strategist.address);
      void expect(await transparentVault.config()).to.equal(await orionConfig.getAddress());
    });

    it("Should reject vault creation with name longer than 26 characters", async function () {
      const longName = "A".repeat(27);
      await expect(
        transparentVaultFactory
          .connect(owner)
          .createVault(strategist.address, longName, "TV", 0, 0, 0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(transparentVaultFactory, "InvalidArguments");
    });

    it("Should reject vault creation with symbol longer than 4 characters", async function () {
      const longSymbol = "SYMBOL";
      await expect(
        transparentVaultFactory
          .connect(owner)
          .createVault(strategist.address, "Test Vault", longSymbol, 0, 0, 0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(transparentVaultFactory, "InvalidArguments");
    });

    it("Should reject fee update with management fee above limit", async function () {
      // Create vault with valid fees first
      const tx = await transparentVaultFactory.connect(owner).createVault(
        strategist.address,
        "Test Vault",
        "TV",
        0, // feeType
        0, // performanceFee
        100, // managementFee (1% - valid)
        ethers.ZeroAddress, // depositAccessControl
      );
      const receipt = await tx.wait();

      // Find the vault creation event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      const testVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      // Try to update with management fee above limit (100% = 10,000 basis points)
      // Maximum allowed is 3% (300 basis points)
      await expect(
        testVault.connect(owner).updateFeeModel(
          0, // feeType
          0, // performanceFee
          10000, // managementFee (100% - should fail)
        ),
      ).to.be.revertedWithCustomError(testVault, "InvalidArguments");
    });

    it("Should reject fee update with performance fee above limit", async function () {
      // Create vault with valid fees first
      const tx = await transparentVaultFactory.connect(owner).createVault(
        strategist.address,
        "Test Vault",
        "TV",
        0, // feeType
        1000, // performanceFee (10% - valid)
        100, // managementFee (1% - valid)
        ethers.ZeroAddress, // depositAccessControl
      );
      const receipt = await tx.wait();

      // Find the vault creation event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      const testVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      // Try to update with performance fee above limit (100% = 10,000 basis points)
      // Maximum allowed is 30% (3,000 basis points)
      await expect(
        testVault.connect(owner).updateFeeModel(
          0, // feeType
          10000, // performanceFee (100% - should fail)
          100, // managementFee (1% - valid)
        ),
      ).to.be.revertedWithCustomError(testVault, "InvalidArguments");
    });
  });

  describe("Strategist Operations", function () {
    beforeEach(async function () {
      // Create a vault first
      const tx = await transparentVaultFactory
        .connect(owner)
        .createVault(strategist.address, "Test Vault", "TV", 0, 0, 0, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      transparentVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;
    });

    it("Should allow manager to update fee model", async function () {
      const feeType = 0; // Performance fee mode
      const performanceFee = 2000; // 20% in basis points
      const managementFee = 100; // 1% in basis points

      await expect(transparentVault.connect(owner).updateFeeModel(feeType, performanceFee, managementFee)).to.not.be
        .reverted;
    });

    it("Should allow strategist to claim vault fees", async function () {
      const claimAmount = ethers.parseUnits("50", 6); // Try to claim 50 USDC

      await expect(transparentVault.connect(owner).claimVaultFees(claimAmount)).to.be.revertedWithCustomError(
        transparentVault,
        "InsufficientAmount",
      );
    });

    it("Should allow strategist to submit intent", async function () {
      // Submit intent with 60% in asset1 and 40% in asset2 (assets must be protocol-whitelisted)
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 600000000, // 60% * 10^9 (strategist intent decimals)
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 400000000, // 40% * 10^9 (strategist intent decimals)
        },
      ];

      await expect(transparentVault.connect(strategist).submitIntent(intent)).to.not.be.reverted;

      // Verify the intent was stored correctly
      const [tokens, weights] = await transparentVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);
      void expect(weights).to.deep.equal([600000000, 400000000]);
    });

    it("Should reject intent with invalid total weight", async function () {
      // Submit intent with total weight != 100%
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 600000000, // 60%
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 300000000, // 30% (total = 90%)
        },
      ];

      await expect(transparentVault.connect(strategist).submitIntent(intent)).to.be.revertedWithCustomError(
        transparentVault,
        "InvalidTotalWeight",
      );
    });

    it("Should reject intent with non-whitelisted assets", async function () {
      // Create a new mock asset that's not in the protocol whitelist
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const nonWhitelistedAsset = await MockERC4626AssetFactory.deploy(
        await underlyingAsset.getAddress(),
        "Non Whitelisted Asset",
        "NWA",
      );
      await nonWhitelistedAsset.waitForDeployment();

      const intent = [
        {
          token: await nonWhitelistedAsset.getAddress(),
          weight: 1000000000, // 100%
        },
      ];

      await expect(transparentVault.connect(strategist).submitIntent(intent)).to.be.revertedWithCustomError(
        transparentVault,
        "TokenNotWhitelisted",
      );
    });

    it("Should reject intent from non-strategist", async function () {
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 1000000000, // 100%
        },
      ];

      await expect(transparentVault.connect(other).submitIntent(intent)).to.be.revertedWithCustomError(
        transparentVault,
        "NotAuthorized",
      );
    });

    it("Should reject absoluteIntent not summing up to 100", async function () {
      // Submit intent with total weight != 100%
      const absoluteIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 600000000, // 60%
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 300000000, // 30% (total = 90%)
        },
      ];

      await expect(transparentVault.connect(strategist).submitIntent(absoluteIntent)).to.be.revertedWithCustomError(
        transparentVault,
        "InvalidTotalWeight",
      );
    });
  });

  describe("Full Pipeline Integration", function () {
    it("Should execute complete strategist pipeline successfully", async function () {
      // 1. Create vault
      const tx = await transparentVaultFactory
        .connect(owner)
        .createVault(strategist.address, "Integration Test Vault", "ITV", 0, 0, 0, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      transparentVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      // 2. Update fee model
      await transparentVault.connect(owner).updateFeeModel(0, 2000, 100);

      // 3. Submit intent
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 700000000, // 70%
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 300000000, // 30%
        },
      ];
      await transparentVault.connect(strategist).submitIntent(intent);

      const [tokens, weights] = await transparentVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);
      void expect(weights).to.deep.equal([700000000, 300000000]);
    });
  });
});
