// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {KutleCouncil} from "../src/governance/KutleCouncil.sol";
import {ConservationLedger, IPassportsForLedger} from "../src/ConservationLedger.sol";

/// No single key administers Kütle: a 2-of-3 council proposes to a timelock,
/// and only the timelock holds admin roles on the contracts.
contract GovernanceTest is Test {
    address internal m1 = makeAddr("member1");
    address internal m2 = makeAddr("member2");
    address internal m3 = makeAddr("member3");
    KutleCouncil internal council;
    TimelockController internal timelock;
    ConservationLedger internal ledger;
    uint256 internal constant DELAY = 2 days;

    function setUp() public {
        address[] memory members = new address[](3);
        members[0] = m1;
        members[1] = m2;
        members[2] = m3;
        council = new KutleCouncil(members, 2);

        address[] memory proposers = new address[](1);
        proposers[0] = address(council);
        address[] memory executors = new address[](1);
        executors[0] = address(council);
        timelock = new TimelockController(DELAY, proposers, executors, address(0));

        ledger = new ConservationLedger(address(timelock), IPassportsForLedger(makeAddr("passports")));
    }

    function _scheduleData(bytes memory call, bytes32 salt) internal view returns (bytes memory) {
        return abi.encodeCall(TimelockController.schedule, (address(ledger), 0, call, bytes32(0), salt, DELAY));
    }

    function _executeData(bytes memory call, bytes32 salt) internal view returns (bytes memory) {
        return abi.encodeCall(TimelockController.execute, (address(ledger), 0, call, bytes32(0), salt));
    }

    function test_twoMembersAndTheDelayAreNeeded() public {
        address lab = makeAddr("lab");
        bytes memory call = abi.encodeCall(ConservationLedger.setLab, (lab, true, keccak256("cert")));
        bytes32 salt = keccak256("add lab");

        vm.prank(m1);
        uint256 id = council.propose(address(timelock), 0, _scheduleData(call, salt), 7 days);
        vm.expectRevert(KutleCouncil.NotEnoughApprovals.selector);
        council.execute(id);

        vm.prank(m2);
        council.approve(id);
        council.execute(id); // scheduled, not yet executable

        vm.prank(m1);
        uint256 id2 = council.propose(address(timelock), 0, _executeData(call, salt), 7 days);
        vm.prank(m3);
        council.approve(id2);
        vm.expectRevert(); // the delay has not passed
        council.execute(id2);

        vm.warp(block.timestamp + DELAY);
        council.execute(id2);
        (bool accredited,) = ledger.labs(lab);
        assertTrue(accredited);
    }

    function test_noMemberCanActAlone() public {
        vm.prank(m1);
        vm.expectRevert();
        ledger.setLab(makeAddr("lab"), true, bytes32(0));

        vm.prank(m1);
        vm.expectRevert();
        timelock.schedule(address(ledger), 0, "", bytes32(0), bytes32(0), DELAY);
    }

    function test_memberCannotApproveTwice() public {
        vm.prank(m1);
        uint256 id = council.propose(address(timelock), 0, "", 1 days);
        vm.prank(m1);
        vm.expectRevert(KutleCouncil.AlreadyApproved.selector);
        council.approve(id);
    }

    function test_expiredProposalCannotExecute() public {
        vm.prank(m1);
        uint256 id = council.propose(address(timelock), 0, "", 1 days);
        vm.prank(m2);
        council.approve(id);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(KutleCouncil.Expired.selector);
        council.execute(id);
    }

    function test_outsiderCannotPropose() public {
        vm.expectRevert(KutleCouncil.NotMember.selector);
        council.propose(address(timelock), 0, "", 1 days);
    }

    function test_badConfigsAreRefused() public {
        address[] memory one = new address[](1);
        one[0] = m1;
        vm.expectRevert(KutleCouncil.BadConfig.selector);
        new KutleCouncil(one, 1);
        address[] memory dup = new address[](2);
        dup[0] = m1;
        dup[1] = m1;
        vm.expectRevert(KutleCouncil.BadConfig.selector);
        new KutleCouncil(dup, 2);
    }
}
