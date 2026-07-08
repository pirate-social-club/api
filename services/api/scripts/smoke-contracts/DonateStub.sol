// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DonateStub {
    event Donated(address indexed donor, uint256 amount);

    function donate(uint256 amount) external {
        emit Donated(msg.sender, amount);
    }
}
