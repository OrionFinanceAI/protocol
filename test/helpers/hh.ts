import { network } from "hardhat";

const connection = await network.getOrCreate();

export const { ethers, provider, networkHelpers } = connection;
export { network };
