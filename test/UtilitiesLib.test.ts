import { expect } from "chai";
import { ethers } from "hardhat";

import { UtilitiesLibTest } from "../typechain-types/contracts/test";

describe("UtilitiesLib", function () {
  let utilitiesLib: UtilitiesLibTest;

  beforeEach(async function () {
    const UtilitiesLibTestFactory = await ethers.getContractFactory("UtilitiesLibTest");
    const deployedContract = await UtilitiesLibTestFactory.deploy();
    await deployedContract.waitForDeployment();
    utilitiesLib = deployedContract as unknown as UtilitiesLibTest;
  });

  describe("convertDecimals", function () {
    describe("when scaling up (toDecimals > fromDecimals)", function () {
      it("should correctly scale up from 6 to 18 decimals", async function () {
        const value = ethers.parseUnits("1000", 6);
        const expected = ethers.parseUnits("1000", 18);

        const result = await utilitiesLib.convertDecimals(value, 6, 18);
        expect(result).to.equal(expected);
      });

      it("should correctly scale up from 0 to 18 decimals", async function () {
        const value = 1000;
        const expected = ethers.parseUnits("1000", 18);

        const result = await utilitiesLib.convertDecimals(value, 0, 18);
        expect(result).to.equal(expected);
      });

      it("should correctly scale up from 6 to 12 decimals", async function () {
        const value = ethers.parseUnits("500", 6); // 500 with 6 decimals
        const expected = ethers.parseUnits("500", 12); // 500 with 12 decimals

        const result = await utilitiesLib.convertDecimals(value, 6, 12);
        expect(result).to.equal(expected);
      });

      it("should handle zero value when scaling up", async function () {
        const value = 0;
        const expected = 0;

        const result = await utilitiesLib.convertDecimals(value, 6, 18);
        expect(result).to.equal(expected);
      });

      it("should handle large values when scaling up", async function () {
        const value = ethers.parseUnits("1000000", 6);
        const expected = ethers.parseUnits("1000000", 18);

        const result = await utilitiesLib.convertDecimals(value, 6, 18);
        expect(result).to.equal(expected);
      });
    });

    describe("when scaling down (toDecimals < fromDecimals)", function () {
      it("should correctly scale down from 18 to 6 decimals", async function () {
        const value = ethers.parseUnits("1000", 18);
        const expected = ethers.parseUnits("1000", 6);

        const result = await utilitiesLib.convertDecimals(value, 18, 6);
        expect(result).to.equal(expected);
      });

      it("should correctly scale down from 18 to 0 decimals", async function () {
        const value = ethers.parseUnits("1000", 18);
        const expected = 1000;

        const result = await utilitiesLib.convertDecimals(value, 18, 0);
        expect(result).to.equal(expected);
      });

      it("should correctly scale down from 12 to 6 decimals", async function () {
        const value = ethers.parseUnits("500", 12);
        const expected = ethers.parseUnits("500", 6);

        const result = await utilitiesLib.convertDecimals(value, 12, 6);
        expect(result).to.equal(expected);
      });

      it("should handle zero value when scaling down", async function () {
        const value = 0;
        const expected = 0;

        const result = await utilitiesLib.convertDecimals(value, 18, 6);
        expect(result).to.equal(expected);
      });

      it("should handle precision loss when scaling down", async function () {
        const value = ethers.parseUnits("1.5", 18);
        const expected = ethers.parseUnits("1.5", 6);

        const result = await utilitiesLib.convertDecimals(value, 18, 6);
        expect(result).to.equal(expected);
      });

      it("should handle large values when scaling down", async function () {
        const value = ethers.parseUnits("1000000", 18);
        const expected = ethers.parseUnits("1000000", 6);

        const result = await utilitiesLib.convertDecimals(value, 18, 6);
        expect(result).to.equal(expected);
      });
    });

    describe("when no conversion needed (toDecimals == fromDecimals)", function () {
      it("should return the same value when decimals are equal (18)", async function () {
        const value = ethers.parseUnits("1000", 18);
        const expected = value;

        const result = await utilitiesLib.convertDecimals(value, 18, 18);
        expect(result).to.equal(expected);
      });

      it("should return the same value when decimals are equal (6)", async function () {
        const value = ethers.parseUnits("1000", 6);
        const expected = value;

        const result = await utilitiesLib.convertDecimals(value, 6, 6);
        expect(result).to.equal(expected);
      });

      it("should return the same value when decimals are equal (0)", async function () {
        const value = 1000;
        const expected = value;

        const result = await utilitiesLib.convertDecimals(value, 0, 0);
        expect(result).to.equal(expected);
      });

      it("should return zero when value is zero and decimals are equal", async function () {
        const value = 0;
        const expected = 0;

        const result = await utilitiesLib.convertDecimals(value, 18, 18);
        expect(result).to.equal(expected);
      });
    });

    describe("edge cases and boundary conditions", function () {
      it("should handle reasonable decimal difference (0 to 18)", async function () {
        const value = 1;
        const expected = ethers.parseUnits("1", 18);

        const result = await utilitiesLib.convertDecimals(value, 0, 18);
        expect(result).to.equal(expected);
      });

      it("should handle reasonable decimal difference (18 to 0)", async function () {
        const value = ethers.parseUnits("1", 18);
        const expected = 1;

        const result = await utilitiesLib.convertDecimals(value, 18, 0);
        expect(result).to.equal(expected);
      });

      it("should handle single decimal difference (17 to 18)", async function () {
        const value = ethers.parseUnits("1000", 17);
        const expected = ethers.parseUnits("1000", 18);

        const result = await utilitiesLib.convertDecimals(value, 17, 18);
        expect(result).to.equal(expected);
      });

      it("should handle single decimal difference (18 to 17)", async function () {
        const value = ethers.parseUnits("1000", 18);
        const expected = ethers.parseUnits("1000", 17);

        const result = await utilitiesLib.convertDecimals(value, 18, 17);
        expect(result).to.equal(expected);
      });

      it("should handle very small values", async function () {
        const value = 1;
        const expected = ethers.parseUnits("1", 12);

        const result = await utilitiesLib.convertDecimals(value, 0, 12);
        expect(result).to.equal(expected);
      });

      it("should handle very large values", async function () {
        const value = ethers.parseUnits("1000000000", 18);
        const expected = ethers.parseUnits("1000000000", 6);

        const result = await utilitiesLib.convertDecimals(value, 18, 6);
        expect(result).to.equal(expected);
      });
    });

    describe("real-world scenarios", function () {
      it("should convert USDC (6 decimals) to WETH (18 decimals)", async function () {
        const usdcAmount = ethers.parseUnits("1000", 6);
        const expectedWethAmount = ethers.parseUnits("1000", 18);

        const result = await utilitiesLib.convertDecimals(usdcAmount, 6, 18);
        expect(result).to.equal(expectedWethAmount);
      });

      it("should convert WETH (18 decimals) to USDC (6 decimals)", async function () {
        const wethAmount = ethers.parseUnits("1000", 18);
        const expectedUsdcAmount = ethers.parseUnits("1000", 6);

        const result = await utilitiesLib.convertDecimals(wethAmount, 18, 6);
        expect(result).to.equal(expectedUsdcAmount);
      });

      it("should convert WBTC (8 decimals) to WETH (18 decimals)", async function () {
        const wbtcAmount = ethers.parseUnits("1", 8);
        const expectedWethAmount = ethers.parseUnits("1", 18);

        const result = await utilitiesLib.convertDecimals(wbtcAmount, 8, 18);
        expect(result).to.equal(expectedWethAmount);
      });

      it("should convert WETH (18 decimals) to WBTC (8 decimals)", async function () {
        const wethAmount = ethers.parseUnits("1", 18);
        const expectedWbtcAmount = ethers.parseUnits("1", 8);

        const result = await utilitiesLib.convertDecimals(wethAmount, 18, 8);
        expect(result).to.equal(expectedWbtcAmount);
      });
    });
  });
});
