// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "../lib/fhevm-solidity/lib/FHE.sol";

contract FHEIntentsERC4626Vault is ERC4626 {
    address public curator;
    address public deployer;

    struct OrderStruct {
        address token;
        euint32 value;
    }

    struct Order {
        OrderStruct[] items;
    }

    Order[] private orders;

    string public fhePublicKeyCID;

    event OrderSubmitted(address indexed curator, uint256 indexed orderId);

    modifier onlyCurator() {
        require(msg.sender == curator, "Not the curator");
        _;
    }

    constructor(
        IERC20 underlyingAsset,
        address _curator,
        string memory _fhePublicKeyCID
    )
        ERC20("FHE Intents Vault Token", "fUSDC")
        ERC4626(underlyingAsset)
    {
        require(_curator != address(0), "Invalid curator address");
        deployer = msg.sender;
        curator = _curator;
        fhePublicKeyCID = _fhePublicKeyCID;
    }

    function submitEncryptedOrder(OrderStruct[] calldata items) external onlyCurator {
        Order storage newOrder = orders.push();
        for (uint256 i = 0; i < items.length; i++) {
            newOrder.items.push(items[i]);
        }

        emit OrderSubmitted(msg.sender, orders.length - 1);
    }

    function getOrderCount() external view returns (uint256) {
        return orders.length;
    }

    function getOrderLength(uint256 orderIndex) external view returns (uint256) {
        require(orderIndex < orders.length, "Order index out of bounds");
        return orders[orderIndex].items.length;
    }

    function getOrderItem(uint256 orderIndex, uint256 itemIndex) external view returns (address, euint32) {
        require(orderIndex < orders.length, "Order index out of bounds");
        require(itemIndex < orders[orderIndex].items.length, "Item index out of bounds");

        OrderStruct storage item = orders[orderIndex].items[itemIndex];
        return (item.token, item.value);
    }

}
