import { network } from "hardhat";

const connection = await network.connect();

export const { ethers, provider, networkHelpers } = connection;
export { network };
