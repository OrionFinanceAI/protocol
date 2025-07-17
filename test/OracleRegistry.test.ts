import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { ERC4626PriceAdapter, MockERC4626Asset, MockPriceAdapter, OracleRegistry } from "../typechain-types";

describe("OracleRegistry", function () {
  let oracleRegistry: OracleRegistry;
  let mockPriceAdapter1: MockPriceAdapter;
  let mockPriceAdapter2: MockPriceAdapter;
  let mockPriceAdapter3: MockPriceAdapter;
  let erc4626PriceAdapter1: ERC4626PriceAdapter;
  let erc4626PriceAdapter2: ERC4626PriceAdapter;
  let mockAsset1: MockERC4626Asset;
  let mockAsset2: MockERC4626Asset;
  let mockAsset3: MockERC4626Asset;
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  const ZERO_ADDRESS = ethers.ZeroAddress;

  beforeEach(async function () {
    [owner, nonOwner] = await ethers.getSigners();

    // Deploy underlying assets first
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset1 = await MockUnderlyingAssetFactory.deploy(6);
    const underlyingAsset2 = await MockUnderlyingAssetFactory.deploy(6);
    const underlyingAsset3 = await MockUnderlyingAssetFactory.deploy(6);

    await underlyingAsset1.waitForDeployment();
    await underlyingAsset2.waitForDeployment();
    await underlyingAsset3.waitForDeployment();

    // Deploy ERC4626 assets with underlying assets
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    mockAsset1 = await MockERC4626AssetFactory.deploy(await underlyingAsset1.getAddress(), "Test Vault 1", "TV1", 18);
    mockAsset2 = await MockERC4626AssetFactory.deploy(await underlyingAsset2.getAddress(), "Test Vault 2", "TV2", 18);
    mockAsset3 = await MockERC4626AssetFactory.deploy(await underlyingAsset3.getAddress(), "Test Vault 3", "TV3", 18);

    await mockAsset1.waitForDeployment();
    await mockAsset2.waitForDeployment();
    await mockAsset3.waitForDeployment();

    const OracleRegistryFactory = await ethers.getContractFactory("OracleRegistry");
    oracleRegistry = await OracleRegistryFactory.deploy();
    await oracleRegistry.waitForDeployment();

    await oracleRegistry.initialize(owner.address);

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter1 = await MockPriceAdapterFactory.deploy();
    mockPriceAdapter2 = await MockPriceAdapterFactory.deploy();
    mockPriceAdapter3 = await MockPriceAdapterFactory.deploy();

    await mockPriceAdapter1.waitForDeployment();
    await mockPriceAdapter2.waitForDeployment();
    await mockPriceAdapter3.waitForDeployment();

    await mockPriceAdapter1.initialize(owner.address);
    await mockPriceAdapter2.initialize(owner.address);
    await mockPriceAdapter3.initialize(owner.address);

    // Deploy ERC4626PriceAdapter contracts
    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
    erc4626PriceAdapter1 = await ERC4626PriceAdapterFactory.deploy();
    erc4626PriceAdapter2 = await ERC4626PriceAdapterFactory.deploy();

    await erc4626PriceAdapter1.waitForDeployment();
    await erc4626PriceAdapter2.waitForDeployment();

    await erc4626PriceAdapter1.initialize(owner.address);
    await erc4626PriceAdapter2.initialize(owner.address);
  });

  describe("setAdapter", function () {
    it("should set adapter for an asset and emit event", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await mockPriceAdapter1.getAddress();

      await expect(oracleRegistry.connect(owner).setAdapter(asset, adapter))
        .to.emit(oracleRegistry, "AdapterSet")
        .withArgs(asset, adapter);

      expect(await oracleRegistry.adapterOf(asset)).to.equal(adapter);
    });

    it("should replace existing adapter", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter1 = await mockPriceAdapter1.getAddress();
      const adapter2 = await mockPriceAdapter2.getAddress();

      await oracleRegistry.connect(owner).setAdapter(asset, adapter1);
      expect(await oracleRegistry.adapterOf(asset)).to.equal(adapter1);

      await expect(oracleRegistry.connect(owner).setAdapter(asset, adapter2))
        .to.emit(oracleRegistry, "AdapterSet")
        .withArgs(asset, adapter2);

      expect(await oracleRegistry.adapterOf(asset)).to.equal(adapter2);
    });

    it("should revert when called by non-owner", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await mockPriceAdapter1.getAddress();

      await expect(oracleRegistry.connect(nonOwner).setAdapter(asset, adapter)).to.be.revertedWithCustomError(
        oracleRegistry,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should revert when asset is zero address", async function () {
      const adapter = await mockPriceAdapter1.getAddress();

      await expect(oracleRegistry.connect(owner).setAdapter(ZERO_ADDRESS, adapter)).to.be.revertedWithCustomError(
        oracleRegistry,
        "ZeroAddress",
      );
    });

    it("should revert when adapter is zero address", async function () {
      const asset = await mockAsset1.getAddress();

      await expect(oracleRegistry.connect(owner).setAdapter(asset, ZERO_ADDRESS)).to.be.revertedWithCustomError(
        oracleRegistry,
        "ZeroAddress",
      );
    });
  });

  describe("getPrice", function () {
    it("should return price from adapter", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await mockPriceAdapter1.getAddress();

      await oracleRegistry.connect(owner).setAdapter(asset, adapter);

      const price = await oracleRegistry.getPrice(asset);
      expect(price).to.not.equal(0);
    });

    it("should revert when adapter is not set", async function () {
      const asset = await mockAsset1.getAddress();

      await expect(oracleRegistry.getPrice(asset)).to.be.revertedWithCustomError(oracleRegistry, "AdapterNotSet");
    });
  });

  describe("Oracle Registry Population", function () {
    it("should populate multiple oracles successfully", async function () {
      const assets = [await mockAsset1.getAddress(), await mockAsset2.getAddress(), await mockAsset3.getAddress()];

      const adapters = [
        await mockPriceAdapter1.getAddress(),
        await mockPriceAdapter2.getAddress(),
        await mockPriceAdapter3.getAddress(),
      ];

      for (let i = 0; i < assets.length; i++) {
        await expect(oracleRegistry.connect(owner).setAdapter(assets[i], adapters[i]))
          .to.emit(oracleRegistry, "AdapterSet")
          .withArgs(assets[i], adapters[i]);
      }

      for (let i = 0; i < assets.length; i++) {
        expect(await oracleRegistry.adapterOf(assets[i])).to.equal(adapters[i]);
        const price = await oracleRegistry.getPrice(assets[i]);
        expect(price).to.not.equal(0);
      }
    });

    it("should populate multiple oracles with mixed adapter types", async function () {
      const assets = [await mockAsset1.getAddress(), await mockAsset2.getAddress(), await mockAsset3.getAddress()];

      const adapters = [
        await mockPriceAdapter1.getAddress(),
        await erc4626PriceAdapter1.getAddress(),
        await erc4626PriceAdapter2.getAddress(),
      ];

      for (let i = 0; i < assets.length; i++) {
        await expect(oracleRegistry.connect(owner).setAdapter(assets[i], adapters[i]))
          .to.emit(oracleRegistry, "AdapterSet")
          .withArgs(assets[i], adapters[i]);
      }

      for (let i = 0; i < assets.length; i++) {
        expect(await oracleRegistry.adapterOf(assets[i])).to.equal(adapters[i]);
        const price = await oracleRegistry.getPrice(assets[i]);
        expect(price).to.not.equal(0);
      }
    });

    it("should validate asset and adapter addresses during population", async function () {
      const validAssets = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      const invalidAdapters = [await mockPriceAdapter1.getAddress(), ZERO_ADDRESS];

      await expect(oracleRegistry.connect(owner).setAdapter(validAssets[0], invalidAdapters[0])).to.emit(
        oracleRegistry,
        "AdapterSet",
      );

      await expect(
        oracleRegistry.connect(owner).setAdapter(validAssets[1], invalidAdapters[1]),
      ).to.be.revertedWithCustomError(oracleRegistry, "ZeroAddress");
    });
  });

  describe("Edge Cases and Error Handling", function () {
    it("should handle multiple rapid setAdapter calls", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter1 = await mockPriceAdapter1.getAddress();
      const adapter2 = await mockPriceAdapter2.getAddress();

      // Rapid successive calls
      await oracleRegistry.connect(owner).setAdapter(asset, adapter1);
      await oracleRegistry.connect(owner).setAdapter(asset, adapter2);
      await oracleRegistry.connect(owner).setAdapter(asset, adapter1);

      expect(await oracleRegistry.adapterOf(asset)).to.equal(adapter1);
    });

    it("should maintain adapter state after multiple updates", async function () {
      const asset1 = await mockAsset1.getAddress();
      const asset2 = await mockAsset2.getAddress();
      const adapter1 = await mockPriceAdapter1.getAddress();
      const adapter2 = await mockPriceAdapter2.getAddress();

      // Set adapters
      await oracleRegistry.connect(owner).setAdapter(asset1, adapter1);
      await oracleRegistry.connect(owner).setAdapter(asset2, adapter2);

      // Update one adapter
      await oracleRegistry.connect(owner).setAdapter(asset1, adapter2);

      // Check both states
      expect(await oracleRegistry.adapterOf(asset1)).to.equal(adapter2);
      expect(await oracleRegistry.adapterOf(asset2)).to.equal(adapter2);
    });

    it("should handle gas-intensive population scenarios", async function () {
      // Test with multiple assets to ensure gas efficiency
      const assets: string[] = [];
      const adapters: string[] = [];

      for (let i = 0; i < 20; i++) {
        // Deploy underlying asset first
        const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
        const underlyingAsset = await MockUnderlyingAssetFactory.deploy(18);
        await underlyingAsset.waitForDeployment();

        // Deploy ERC4626 asset with underlying asset
        const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
        const asset = await MockERC4626AssetFactory.deploy(
          await underlyingAsset.getAddress(),
          `Test Vault ${i}`,
          `TV${i}`,
          18,
        );
        await asset.waitForDeployment();

        // Alternate between MockPriceAdapter and ERC4626PriceAdapter
        if (i % 2 === 0) {
          const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
          const adapter = await MockPriceAdapterFactory.deploy();
          await adapter.waitForDeployment();
          await adapter.initialize(owner.address);
          adapters.push(await adapter.getAddress());
        } else {
          const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
          const adapter = await ERC4626PriceAdapterFactory.deploy();
          await adapter.waitForDeployment();
          await adapter.initialize(owner.address);
          adapters.push(await adapter.getAddress());
        }

        assets.push(await asset.getAddress());
      }

      for (let i = 0; i < assets.length; i++) {
        await oracleRegistry.connect(owner).setAdapter(assets[i], adapters[i]);
      }

      for (let i = 0; i < assets.length; i++) {
        expect(await oracleRegistry.adapterOf(assets[i])).to.equal(adapters[i]);
      }
    });
  });

  describe("Access Control", function () {
    it("should only allow owner to set adapters", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await mockPriceAdapter1.getAddress();

      await expect(oracleRegistry.connect(nonOwner).setAdapter(asset, adapter)).to.be.revertedWithCustomError(
        oracleRegistry,
        "OwnableUnauthorizedAccount",
      );

      await expect(oracleRegistry.connect(owner).setAdapter(asset, adapter)).to.emit(oracleRegistry, "AdapterSet");
    });

    it("should allow anyone to read prices", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await mockPriceAdapter1.getAddress();

      await oracleRegistry.connect(owner).setAdapter(asset, adapter);

      const priceFromOwner = await oracleRegistry.connect(owner).getPrice(asset);
      const priceFromNonOwner = await oracleRegistry.connect(nonOwner).getPrice(asset);

      expect(priceFromOwner).to.equal(priceFromNonOwner);
      expect(priceFromOwner).to.not.equal(0);
    });
  });

  describe("ERC4626PriceAdapter Integration", function () {
    it("should set ERC4626PriceAdapter and get price", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await erc4626PriceAdapter1.getAddress();

      await expect(oracleRegistry.connect(owner).setAdapter(asset, adapter))
        .to.emit(oracleRegistry, "AdapterSet")
        .withArgs(asset, adapter);

      const price = await oracleRegistry.getPrice(asset);
      expect(price).to.not.equal(0);
    });

    it("should switch between MockPriceAdapter and ERC4626PriceAdapter", async function () {
      const asset = await mockAsset1.getAddress();
      const mockAdapter = await mockPriceAdapter1.getAddress();
      const erc4626Adapter = await erc4626PriceAdapter1.getAddress();

      // Set MockPriceAdapter first
      await oracleRegistry.connect(owner).setAdapter(asset, mockAdapter);
      const mockPrice = await oracleRegistry.getPrice(asset);

      // Switch to ERC4626PriceAdapter
      await oracleRegistry.connect(owner).setAdapter(asset, erc4626Adapter);
      const erc4626Price = await oracleRegistry.getPrice(asset);

      expect(mockPrice).to.not.equal(0);
      expect(erc4626Price).to.not.equal(0);
      expect(await oracleRegistry.adapterOf(asset)).to.equal(erc4626Adapter);
    });

    it("should handle multiple ERC4626PriceAdapters", async function () {
      const asset1 = await mockAsset1.getAddress();
      const asset2 = await mockAsset2.getAddress();
      const adapter1 = await erc4626PriceAdapter1.getAddress();
      const adapter2 = await erc4626PriceAdapter2.getAddress();

      await oracleRegistry.connect(owner).setAdapter(asset1, adapter1);
      await oracleRegistry.connect(owner).setAdapter(asset2, adapter2);

      const price1 = await oracleRegistry.getPrice(asset1);
      const price2 = await oracleRegistry.getPrice(asset2);

      expect(price1).to.not.equal(0);
      expect(price2).to.not.equal(0);
      expect(await oracleRegistry.adapterOf(asset1)).to.equal(adapter1);
      expect(await oracleRegistry.adapterOf(asset2)).to.equal(adapter2);
    });

    it("should populate mixed adapter types", async function () {
      const assets = [await mockAsset1.getAddress(), await mockAsset2.getAddress(), await mockAsset3.getAddress()];

      const adapters = [
        await mockPriceAdapter1.getAddress(),
        await erc4626PriceAdapter1.getAddress(),
        await erc4626PriceAdapter2.getAddress(),
      ];

      for (let i = 0; i < assets.length; i++) {
        await expect(oracleRegistry.connect(owner).setAdapter(assets[i], adapters[i]))
          .to.emit(oracleRegistry, "AdapterSet")
          .withArgs(assets[i], adapters[i]);
      }

      for (let i = 0; i < assets.length; i++) {
        expect(await oracleRegistry.adapterOf(assets[i])).to.equal(adapters[i]);
        const price = await oracleRegistry.getPrice(assets[i]);
        expect(price).to.not.equal(0);
      }
    });

    it("should get consistent prices from ERC4626PriceAdapter", async function () {
      const asset = await mockAsset1.getAddress();
      const adapter = await erc4626PriceAdapter1.getAddress();

      await oracleRegistry.connect(owner).setAdapter(asset, adapter);

      const price1 = await oracleRegistry.getPrice(asset);
      const price2 = await oracleRegistry.getPrice(asset);
      const price3 = await oracleRegistry.getPrice(asset);

      expect(price1).to.equal(price2);
      expect(price2).to.equal(price3);
      expect(price1).to.not.equal(0);
    });
  });
});
