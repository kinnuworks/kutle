// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ModelRegistry
/// @notice Versions of the battery health model. Every grade on a passport names
///         the model that produced it, so anyone can fetch the exact weights by
///         hash and re-run it.
///
///         A model is accepted only if its reported error on a held-out dataset
///         beats the stated baseline. The numbers are self-reported, but they are
///         published next to hashes of the weights, the evaluation set and the
///         evaluation code, so a false claim is checkable.
contract ModelRegistry is AccessControl {
    struct Model {
        bytes32 weightsHash; // sha256 of the exported model file
        bytes32 evalDataHash; // sha256 of the held-out evaluation set
        bytes32 codeHash; // git commit of the training and evaluation code
        uint32 maeBps; // held-out mean absolute error of state of health, in bps
        uint32 baselineMaeBps; // same metric for the baseline on the same set
        uint32 coverageBps; // empirical coverage of the prediction interval
        uint64 registeredAt;
        bool active;
        string uri; // where the model card and weights are published
    }

    mapping(bytes32 => Model) private _models;

    event ModelRegistered(bytes32 indexed modelId, bytes32 weightsHash, uint32 maeBps, uint32 baselineMaeBps, uint32 coverageBps, string uri);
    event ModelRetired(bytes32 indexed modelId);

    error ModelExists();
    error UnknownModel();
    error DoesNotBeatBaseline(uint32 maeBps, uint32 baselineMaeBps);
    error CoverageTooLow(uint32 coverageBps);

    /// Prediction intervals must cover at least 85% of held-out truths.
    uint32 public constant MIN_COVERAGE_BPS = 8_500;

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function register(bytes32 modelId, Model calldata m) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_models[modelId].registeredAt != 0) revert ModelExists();
        if (m.maeBps >= m.baselineMaeBps) revert DoesNotBeatBaseline(m.maeBps, m.baselineMaeBps);
        if (m.coverageBps < MIN_COVERAGE_BPS) revert CoverageTooLow(m.coverageBps);
        Model storage s = _models[modelId];
        s.weightsHash = m.weightsHash;
        s.evalDataHash = m.evalDataHash;
        s.codeHash = m.codeHash;
        s.maeBps = m.maeBps;
        s.baselineMaeBps = m.baselineMaeBps;
        s.coverageBps = m.coverageBps;
        s.registeredAt = uint64(block.timestamp);
        s.active = true;
        s.uri = m.uri;
        emit ModelRegistered(modelId, m.weightsHash, m.maeBps, m.baselineMaeBps, m.coverageBps, m.uri);
    }

    function retire(bytes32 modelId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_models[modelId].registeredAt == 0) revert UnknownModel();
        _models[modelId].active = false;
        emit ModelRetired(modelId);
    }

    function model(bytes32 modelId) external view returns (Model memory) {
        return _models[modelId];
    }

    function isActive(bytes32 modelId) external view returns (bool) {
        return _models[modelId].active;
    }
}
