import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";

dotenv.config();

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "cancun",
        },
      },
    ],
  },
  networks: {
    sepolia: {
      url: process.env.RPC_URL,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY!, process.env.LP_PRIVATE_KEY!],
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
      chainId: 31337,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  gasReporter: {
    currency: "USD",
    enabled: process.env.REPORT_GAS ? true : false,
    excludeContracts: [],
  },
};

export default config;
