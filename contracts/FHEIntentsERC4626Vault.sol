// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "../lib/fhevm-solidity/lib/FHE.sol";

interface IConfig {
    function isWhitelisted(address vault) external view returns (bool);
    function getFhePublicCID() external view returns (string memory);
}

contract FHEIntentsERC4626Vault is ERC4626 {
    address public curator;
    address public deployer;
    IConfig public config;

    struct OrderStruct {
        address token;
        euint32 value;
    }

    struct Order {
        OrderStruct[] items;
    }

    Order[] private orders;

    event OrderSubmitted(address indexed curator, uint256 indexed orderId);

    modifier onlyCurator() {
        require(msg.sender == curator, "Not the curator");
        _;
    }

    constructor(
        IERC20 underlyingAsset,
        address _curator,
        address _config
    )
        ERC20("FHE Intents Vault Token", "fUSDC")
        ERC4626(underlyingAsset)
    {
        require(_curator != address(0), "Invalid curator address");
        deployer = msg.sender;
        curator = _curator;
        config = IConfig(_config);
    }

    function submitEncryptedOrder(OrderStruct[] calldata items) external onlyCurator {
        require(items.length > 0, "Order cannot be empty");

        Order storage newOrder = orders.push();

        for (uint256 i = 0; i < items.length; i++) {
            if (config.isWhitelisted(items[i].token)) {
                newOrder.items.push(items[i]);
            }
        }

        require(newOrder.items.length > 0, "No whitelisted tokens in order");

        emit OrderSubmitted(msg.sender, orders.length - 1);
    }
    
}
