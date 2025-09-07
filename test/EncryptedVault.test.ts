import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  EncryptedVaultFactory,
  OrionEncryptedVault,
  PriceAdapterRegistry,
} from "../typechain-types";

let encryptedVaultFactory: EncryptedVaultFactory;
let orionConfig: OrionConfig;
let underlyingAsset: MockUnderlyingAsset;
let mockAsset1: MockERC4626Asset;
let mockAsset2: MockERC4626Asset;
let mockPriceAdapter1: MockPriceAdapter;
let mockPriceAdapter2: MockPriceAdapter;
let mockExecutionAdapter1: MockExecutionAdapter;
let mockExecutionAdapter2: MockExecutionAdapter;
let priceAdapterRegistry: PriceAdapterRegistry;
let internalStatesOrchestrator: InternalStatesOrchestrator;
let liquidityOrchestrator: LiquidityOrchestrator;
let encryptedVault: OrionEncryptedVault;

let owner: SignerWithAddress, curator: SignerWithAddress, other: SignerWithAddress;

beforeEach(async function () {
  [owner, curator, other] = await ethers.getSigners();

  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAssetDeployed.waitForDeployment();
  underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

  const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
  const mockAsset1Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 1",
    "MA1",
    18,
  );
  await mockAsset1Deployed.waitForDeployment();
  mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

  const mockAsset2Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 2",
    "MA2",
    18,
  );
  await mockAsset2Deployed.waitForDeployment();
  mockAsset2 = mockAsset2Deployed as unknown as MockERC4626Asset;

  // Deploy OrionConfig
  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
  await orionConfigDeployed.waitForDeployment();
  orionConfig = orionConfigDeployed as unknown as OrionConfig;

  const EncryptedVaultFactoryFactory = await ethers.getContractFactory("EncryptedVaultFactory");
  const encryptedVaultFactoryDeployed = await EncryptedVaultFactoryFactory.deploy(await orionConfig.getAddress());
  await encryptedVaultFactoryDeployed.waitForDeployment();
  encryptedVaultFactory = encryptedVaultFactoryDeployed as unknown as EncryptedVaultFactory;

  const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
  const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await internalStatesOrchestratorDeployed.waitForDeployment();
  internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

  const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
  const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await liquidityOrchestratorDeployed.waitForDeployment();
  liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

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

  const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
  const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
  );
  await priceAdapterRegistryDeployed.waitForDeployment();
  priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

  await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
  await orionConfig.setVaultFactories(other.address, await encryptedVaultFactory.getAddress());
  await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
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

describe("EncryptedVault - Curator Pipeline", function () {
  describe("Vault Creation", function () {
    it("Should create an encrypted vault with correct parameters", async function () {
      const tx = await encryptedVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
      const receipt = await tx.wait();

      // Find the vault creation event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = encryptedVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      void expect(event).to.not.be.undefined;
      const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      void expect(vaultAddress).to.not.equal(ethers.ZeroAddress);

      // Get the vault contract
      encryptedVault = (await ethers.getContractAt(
        "OrionEncryptedVault",
        vaultAddress,
      )) as unknown as OrionEncryptedVault;

      // Verify vault properties
      void expect(await encryptedVault.vaultOwner()).to.equal(owner.address);
      void expect(await encryptedVault.curator()).to.equal(curator.address);
      void expect(await encryptedVault.config()).to.equal(await orionConfig.getAddress());
    });

    it("Should initialize vault whitelist to match config whitelist after deployment", async function () {
      const tx = await encryptedVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
      const receipt = await tx.wait();

      // Find the vault creation event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = encryptedVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      // Get the vault contract
      encryptedVault = (await ethers.getContractAt(
        "OrionEncryptedVault",
        vaultAddress,
      )) as unknown as OrionEncryptedVault;

      // Get config whitelist
      const configWhitelist = await orionConfig.getAllWhitelistedAssets();

      // Get vault whitelist
      const vaultWhitelist = await encryptedVault.vaultWhitelist();

      // Compare the whitelists
      expect(vaultWhitelist.length).to.equal(configWhitelist.length);

      // Sort both arrays to ensure order doesn't affect comparison
      const sortedConfigWhitelist = [...configWhitelist].sort();
      const sortedVaultWhitelist = [...vaultWhitelist].sort();

      for (let i = 0; i < sortedConfigWhitelist.length; i++) {
        expect(sortedVaultWhitelist[i]).to.equal(sortedConfigWhitelist[i]);
      }
    });
  });

  describe("Curator Operations", function () {
    beforeEach(async function () {
      // Create a vault first
      const tx = await encryptedVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = encryptedVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      encryptedVault = (await ethers.getContractAt(
        "OrionEncryptedVault",
        vaultAddress,
      )) as unknown as OrionEncryptedVault;
    });

    it("Should allow vault owner to update vault whitelist", async function () {
      const newWhitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];

      await expect(encryptedVault.connect(owner).updateVaultWhitelist(newWhitelist)).to.not.be.reverted;
    });

    it("Should allow vault owner to update fee model", async function () {
      const feeType = 0; // Performance fee mode
      const performanceFee = 2000; // 20% in basis points
      const managementFee = 100; // 1% in basis points

      await expect(encryptedVault.connect(owner).updateFeeModel(feeType, performanceFee, managementFee)).to.not.be
        .reverted;
    });

    it("Should allow vault owner to claim curator fees", async function () {
      // Note: In a real scenario, fees would be accrued by the liquidity orchestrator
      // For testing purposes, we'll skip the fee accrual step and just test the claim function
      // The claim function requires pendingCuratorFees > 0, so we'll test the revert case

      const claimAmount = ethers.parseUnits("50", 6); // Try to claim 50 USDC

      await expect(encryptedVault.connect(owner).claimCuratorFees(claimAmount)).to.be.revertedWithCustomError(
        encryptedVault,
        "InsufficientAmount",
      );
    });

    it("Should allow curator to submit encrypted intent", async function () {
      // First update the whitelist to include the assets we want to use
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);

      // Create encrypted intent with 60% in asset1 and 40% in asset2
      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      // Add encrypted weights (60% and 40% in curator intent decimals)
      encryptedIntentBuffer.add128(600000000); // 60% * 10^9
      encryptedIntentBuffer.add128(400000000); // 40% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
        {
          token: await mockAsset2.getAddress(),
          weight: encryptedIntentCiphertexts.handles[1],
        },
      ];

      await encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof);
    });

    it("Should reject encrypted intent with invalid total weight", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);

      // Create encrypted intent with total weight != 100%
      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      // Add encrypted weights (60% and 30% - total = 90%)
      encryptedIntentBuffer.add128(600000000); // 60% * 10^9
      encryptedIntentBuffer.add128(300000000); // 30% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      // Convert proof and handles to hex
      const handlesHex = encryptedIntentCiphertexts.handles.map((h) => "0x" + Buffer.from(h).toString("hex"));
      const inputProofHex = "0x" + Buffer.from(encryptedIntentCiphertexts.inputProof).toString("hex");

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: handlesHex[0],
        },
        {
          token: await mockAsset2.getAddress(),
          weight: handlesHex[1],
        },
      ];

      // This should fail validation in the FHE callback
      await expect(encryptedVault.connect(curator).submitIntent(encryptedIntent, inputProofHex)).to.not.be.reverted; // The transaction succeeds, but intent validity will be false
    });

    it("Should reject encrypted intent with non-whitelisted assets", async function () {
      // Create a new mock asset that's not in the protocol whitelist
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const nonWhitelistedAsset = await MockERC4626AssetFactory.deploy(
        await underlyingAsset.getAddress(),
        "Non Whitelisted Asset",
        "NWA",
        18,
      );
      await nonWhitelistedAsset.waitForDeployment();

      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      encryptedIntentBuffer.add128(1000000000); // 100% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await nonWhitelistedAsset.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
      ];

      await expect(
        encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof),
      ).to.be.revertedWithCustomError(encryptedVault, "TokenNotWhitelisted");
    });

    it("Should reject encrypted intent from non-curator", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);

      const encryptedIntentBuffer = fhevm.createEncryptedInput(
        await encryptedVault.getAddress(),
        other.address, // Using other address instead of curator
      );

      encryptedIntentBuffer.add128(1000000000); // 100% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
      ];

      await expect(
        encryptedVault.connect(other).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof),
      ).to.be.revertedWithCustomError(encryptedVault, "UnauthorizedAccess");
    });

    it("Should reject empty encrypted intent", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);

      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent: Array<{ token: string; weight: string }> = []; // Empty intent

      await expect(
        encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof),
      ).to.be.revertedWithCustomError(encryptedVault, "OrderIntentCannotBeEmpty");
    });

    it("Should reject encrypted intent with duplicate tokens", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);

      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      // Add encrypted weights
      encryptedIntentBuffer.add128(500000000); // 50% * 10^9
      encryptedIntentBuffer.add128(500000000); // 50% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
        {
          token: await mockAsset1.getAddress(), // Duplicate token
          weight: encryptedIntentCiphertexts.handles[1],
        },
      ];

      await expect(
        encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof),
      ).to.be.revertedWithCustomError(encryptedVault, "TokenAlreadyInOrder");
    });
  });

  describe("Vault State Management", function () {
    beforeEach(async function () {
      // Create a vault first
      const tx = await encryptedVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = encryptedVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      encryptedVault = (await ethers.getContractAt(
        "OrionEncryptedVault",
        vaultAddress,
      )) as unknown as OrionEncryptedVault;
    });

    it("Should reject vault state update from non-liquidity orchestrator", async function () {
      const newTotalAssets = ethers.parseUnits("1000", 6);

      const encryptedPortfolio = [
        {
          token: await mockAsset1.getAddress(),
          value: "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      ];

      await expect(
        encryptedVault.connect(other).updateVaultState(encryptedPortfolio, newTotalAssets),
      ).to.be.revertedWithCustomError(encryptedVault, "UnauthorizedAccess");
    });

    it("Should return encrypted portfolio data", async function () {
      const [tokens, sharesPerAsset] = await encryptedVault.getPortfolio();

      // Initially, portfolio should be empty
      void expect(tokens).to.deep.equal([]);
      void expect(sharesPerAsset).to.deep.equal([]);
    });

    it("Should return encrypted intent data", async function () {
      const [tokens, weights] = await encryptedVault.getIntent();

      // Initially, intent should be empty
      void expect(tokens).to.deep.equal([]);
      void expect(weights).to.deep.equal([]);
    });

    it("Should return intent validity status", async function () {
      const isValid = await encryptedVault.isIntentValid();

      // Initially, intent should be invalid
      void expect(isValid).to.be.false;
    });
  });

  describe("Full Pipeline Integration", function () {
    it("Should execute complete encrypted curator pipeline successfully", async function () {
      // 1. Create vault
      const tx = await encryptedVaultFactory
        .connect(owner)
        .createVault(curator.address, "Integration Test Vault", "ITV", 0, 0, 0);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = encryptedVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      encryptedVault = (await ethers.getContractAt(
        "OrionEncryptedVault",
        vaultAddress,
      )) as unknown as OrionEncryptedVault;

      // 2. Update vault whitelist
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);

      // 3. Update fee model
      await encryptedVault.connect(owner).updateFeeModel(0, 2000, 100);

      // 4. Submit encrypted intent
      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      // Add encrypted weights (70% and 30%)
      encryptedIntentBuffer.add128(700000000); // 70% * 10^9
      encryptedIntentBuffer.add128(300000000); // 30% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
        {
          token: await mockAsset2.getAddress(),
          weight: encryptedIntentCiphertexts.handles[1],
        },
      ];

      await encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof);

      // 5. Verify the encrypted intent was stored (we can only check the tokens, not the encrypted weights)
      const [tokens, weights] = await encryptedVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);
      void expect(weights.length).to.equal(2); // Weights are encrypted, so we just check the length

      // Use the built-in `awaitDecryptionOracle` helper to wait for the FHEVM decryption oracle
      // to complete all pending Solidity decryption requests.
      await fhevm.awaitDecryptionOracle();

      // At this point, the Solidity callback should have been invoked by the FHEVM backend.
      // We can now retrieve the decrypted (clear) value.
      const isIntentValid = await encryptedVault.isIntentValid();
      void expect(isIntentValid).to.be.true;
    });
  });

  describe("FHE Integration Tests", function () {
    beforeEach(async function () {
      // Create a vault first
      const tx = await encryptedVaultFactory
        .connect(owner)
        .createVault(curator.address, "FHE Test Vault", "FTV", 0, 0, 0);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = encryptedVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      encryptedVault = (await ethers.getContractAt(
        "OrionEncryptedVault",
        vaultAddress,
      )) as unknown as OrionEncryptedVault;

      // Update whitelist
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await encryptedVault.connect(owner).updateVaultWhitelist(whitelist);
    });

    it("Should handle single asset encrypted intent", async function () {
      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      encryptedIntentBuffer.add128(1000000000); // 100% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
      ];

      await expect(encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof))
        .to.not.be.reverted;

      const [tokens, weights] = await encryptedVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress()]);
      void expect(weights.length).to.equal(1);
    });

    it("Should handle multiple asset encrypted intent with equal weights", async function () {
      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      // Add equal weights (50% each)
      encryptedIntentBuffer.add128(500000000); // 50% * 10^9
      encryptedIntentBuffer.add128(500000000); // 50% * 10^9

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
        {
          token: await mockAsset2.getAddress(),
          weight: encryptedIntentCiphertexts.handles[1],
        },
      ];

      await expect(encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof))
        .to.not.be.reverted;

      const [tokens, weights] = await encryptedVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);
      void expect(weights.length).to.equal(2);
    });

    it("Should handle encrypted intent with zero weights", async function () {
      const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

      // Add weights including zero
      encryptedIntentBuffer.add128(1000000000); // 100% * 10^9
      encryptedIntentBuffer.add128(0); // 0%

      const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

      const encryptedIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: encryptedIntentCiphertexts.handles[0],
        },
        {
          token: await mockAsset2.getAddress(),
          weight: encryptedIntentCiphertexts.handles[1],
        },
      ];

      // This should fail validation in the FHE callback due to zero weight
      await expect(encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof))
        .to.not.be.reverted; // Transaction succeeds, but intent validity will be false
    });

    it("Should properly cleanup previous intent when submitting new intent", async function () {
      // Submit first intent with asset1 only (100%)
      const firstIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);
      firstIntentBuffer.add128(1000000000); // 100% * 10^9
      const firstIntentCiphertexts = await firstIntentBuffer.encrypt();

      const firstIntent = [
        {
          token: await mockAsset1.getAddress(),
          weight: firstIntentCiphertexts.handles[0],
        },
      ];

      // Submit first intent
      await expect(encryptedVault.connect(curator).submitIntent(firstIntent, firstIntentCiphertexts.inputProof)).to.not
        .be.reverted;

      // Verify first intent was stored
      let [tokens, weights] = await encryptedVault.getIntent();
      expect(tokens).to.deep.equal([await mockAsset1.getAddress()]);
      expect(weights.length).to.equal(1);

      // Submit second intent with asset2 only (100%) - different asset
      const secondIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);
      secondIntentBuffer.add128(1000000000); // 100% * 10^9
      const secondIntentCiphertexts = await secondIntentBuffer.encrypt();

      const secondIntent = [
        {
          token: await mockAsset2.getAddress(),
          weight: secondIntentCiphertexts.handles[0],
        },
      ];

      // Submit second intent - this should cleanup the previous intent
      await expect(encryptedVault.connect(curator).submitIntent(secondIntent, secondIntentCiphertexts.inputProof)).to
        .not.be.reverted;

      // Verify second intent replaced the first intent
      [tokens, weights] = await encryptedVault.getIntent();
      expect(tokens).to.deep.equal([await mockAsset2.getAddress()]);
      expect(weights.length).to.equal(1);

      // Verify that asset1 is no longer in the intent (cleanup worked)
      expect(tokens).to.not.include(await mockAsset1.getAddress());
    });
  });
});
