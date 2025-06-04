import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import "@nomiclabs/hardhat-ethers";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: "0.8.24",
  networks: {
    sepolia: {
      url: process.env.RPC_URL,
      accounts: [
        process.env.DEPLOYER_PRIVATE_KEY!,
        process.env.LP_PRIVATE_KEY!,
        process.env.CURATOR_PRIVATE_KEY!,
      ],    
  },
  localhost: {
    url: "http://127.0.0.1:8545",
    gas: "auto",
    gasPrice: 2000000000,
  },
  hardhat: {
    forking: {
      url: process.env.RPC_URL!,
      blockNumber: 5555555,
    },
    chainId: 11155111,
  },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;