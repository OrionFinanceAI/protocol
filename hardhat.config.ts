import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "solidity-docgen";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";

dotenv.config({ quiet: true });

const isCoverage = process.env.SOLIDITY_COVERAGE === "true";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",

  docgen: {
    outputDir: "./docs/",
    pages: "files",
    exclude: ["mocks", "test"],
  },

  solidity: {
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
      chainId: 31337,
      initialBaseFeePerGas: 0,
      // Fork mainnet when:
      // 1. FORK_MAINNET=true (explicit forking for crossAsset tests)
      // 2. SOLIDITY_COVERAGE=true (coverage needs forking for crossAsset tests)
      ...((process.env.FORK_MAINNET === "true" || process.env.SOLIDITY_COVERAGE === "true") &&
      process.env.MAINNET_RPC_URL
        ? {
            forking: {
              url: process.env.MAINNET_RPC_URL,
              blockNumber: 24490214,
            },
          }
        : {}),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      gas: "auto",
      gasPrice: 2_000_000_000,
    },

    ...(!isCoverage
      ? {
          sepolia: {
            url: process.env.RPC_URL!,
            accounts: [process.env.DEPLOYER_PRIVATE_KEY!, process.env.LP_PRIVATE_KEY!],
            chainId: 11155111,
          },
        }
      : {}),
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },

  gasReporter: {
    currency: "USD",
    gasPrice: 3,
    token: "ETH",
    tokenPrice: "4700",
    enabled: Boolean(process.env.REPORT_GAS),
    excludeContracts: [],
    outputFile: "reports/gas-report.txt",
    noColors: true,
    showMethodSig: true,
  },
};

export default config;
