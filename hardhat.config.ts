import * as dotenv from "dotenv";
import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatTypechain from "@nomicfoundation/hardhat-typechain";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

dotenv.config({ quiet: true });

const useMainnetFork = process.env.FORK_MAINNET === "true" && Boolean(process.env.MAINNET_RPC_URL);

const config = defineConfig({
  plugins: [hardhatToolboxMochaEthers, hardhatTypechain, hardhatVerify],
  defaultNetwork: "hardhat",
  solidity: {
    npmFilesToBuild: [
      "@openzeppelin/contracts/token/ERC20/IERC20.sol",
      "@openzeppelin/contracts/interfaces/IERC4626.sol",
      "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol",
    ],
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 10,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    ],
  },

  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
      initialBaseFeePerGas: 0,
      ...(useMainnetFork
        ? {
            forking: {
              url: process.env.MAINNET_RPC_URL!,
              blockNumber: 24490214,
            },
          }
        : {}),
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    ...((process.env.SEPOLIA_RPC_URL ?? process.env.RPC_URL)
      ? {
          sepolia: {
            type: "http",
            chainType: "l1",
            url: process.env.SEPOLIA_RPC_URL ?? process.env.RPC_URL!,
            accounts: [process.env.DEPLOYER_PRIVATE_KEY!, process.env.LP_PRIVATE_KEY!],
            chainId: 11155111,
          },
        }
      : {}),
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
});

export default config;
