// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title KutleCouncil
/// @notice A small M-of-N multisig. It is the only proposer on the timelock that
///         administers every Kütle contract, so no single key can grant a role,
///         swap a verifier or register a lab. Members are fixed at deployment and
///         can only be changed by the council itself, through the timelock.
contract KutleCouncil {
    struct Proposal {
        address target;
        uint256 value;
        bytes data;
        uint64 deadline;
        uint8 approvals;
        bool executed;
    }

    uint8 public immutable threshold;
    address[] private _members;
    mapping(address => bool) public isMember;

    Proposal[] private _proposals;
    mapping(uint256 => mapping(address => bool)) public approved;

    event Proposed(uint256 indexed id, address indexed proposer, address target, uint256 value, bytes data, uint64 deadline);
    event Approved(uint256 indexed id, address indexed member, uint8 approvals);
    event Executed(uint256 indexed id, bytes result);

    error NotMember();
    error BadConfig();
    error UnknownProposal();
    error AlreadyApproved();
    error AlreadyExecuted();
    error Expired();
    error NotEnoughApprovals();
    error CallFailed(bytes reason);

    modifier onlyMember() {
        if (!isMember[msg.sender]) revert NotMember();
        _;
    }

    constructor(address[] memory members_, uint8 threshold_) {
        if (threshold_ < 2 || threshold_ > members_.length) revert BadConfig();
        for (uint256 i; i < members_.length; ++i) {
            address m = members_[i];
            if (m == address(0) || isMember[m]) revert BadConfig();
            isMember[m] = true;
            _members.push(m);
        }
        threshold = threshold_;
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposal(uint256 id) external view returns (Proposal memory) {
        if (id >= _proposals.length) revert UnknownProposal();
        return _proposals[id];
    }

    /// @notice Propose a call. The proposer's approval counts as the first one.
    function propose(address target, uint256 value, bytes calldata data, uint64 ttl)
        external
        onlyMember
        returns (uint256 id)
    {
        id = _proposals.length;
        uint64 deadline = uint64(block.timestamp) + ttl;
        _proposals.push(Proposal(target, value, data, deadline, 0, false));
        emit Proposed(id, msg.sender, target, value, data, deadline);
        _approve(id);
    }

    function approve(uint256 id) external onlyMember {
        _approve(id);
    }

    /// @notice Execute once enough members approved. Anyone may trigger it.
    function execute(uint256 id) external returns (bytes memory result) {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (block.timestamp > p.deadline) revert Expired();
        if (p.approvals < threshold) revert NotEnoughApprovals();
        p.executed = true;
        bool ok;
        (ok, result) = p.target.call{value: p.value}(p.data);
        if (!ok) revert CallFailed(result);
        emit Executed(id, result);
    }

    function _approve(uint256 id) private {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (block.timestamp > p.deadline) revert Expired();
        if (approved[id][msg.sender]) revert AlreadyApproved();
        approved[id][msg.sender] = true;
        unchecked {
            ++p.approvals;
        }
        emit Approved(id, msg.sender, p.approvals);
    }

    receive() external payable {}
}
