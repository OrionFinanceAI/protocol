import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "solidity-docgen";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";

dotenv.config({ quiet: true });

// --- Env guards --------------------------------------------------------------

const hasSepolia =
  typeof process.env.RPC_URL === "string" &&
  process.env.RPC_URL.length > 0 &&
  typeof process.env.DEPLOYER_PRIVATE_KEY === "string" &&
  process.env.DEPLOYER_PRIVATE_KEY.length > 0 &&
  typeof process.env.LP_PRIVATE_KEY === "string" &&
  process.env.LP_PRIVATE_KEY.length > 0;

// ---------------------------------------------------------------------------

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
      forking: process.env.RPC_URL
        ? {
            url: process.env.RPC_URL,
            enabled: true,
            blockNumber: 10000000,
          }
        : undefined,
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      gas: "auto",
      gasPrice: 2_000_000_000,
    },

    // Only defined when env vars exist
    ...(hasSepolia
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

  mocha: {
    timeout: 40000,
  },
};

export default config;
