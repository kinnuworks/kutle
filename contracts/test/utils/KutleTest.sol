// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MLDSA44Verifier} from "mldsa/MLDSA44Verifier.sol";
import {Poseidon2Yul_BN254} from "poseidon2/bn254/yul/Poseidon2Yul.sol";
import {IPoseidon2} from "poseidon2/IPoseidon2.sol";

import {DeviceRegistry} from "../../src/DeviceRegistry.sol";
import {ModelRegistry} from "../../src/ModelRegistry.sol";
import {ReadingLog, IPassportDevice} from "../../src/ReadingLog.sol";
import {PassportRegistry, IReadingLog, ILedgerTaint} from "../../src/PassportRegistry.sol";
import {ConservationLedger, IPassportsForLedger, INotePoolInsert} from "../../src/ConservationLedger.sol";
import {NotePool, IShieldedSpendVerifier, IPassportsForNotes} from "../../src/NotePool.sol";
import {MockSpendVerifier} from "./MockSpendVerifier.sol";

/// @notice Deploys the full system the way the deploy script does, with the real
///         ML-DSA-44 verifier and the real Poseidon2. Only the ZK spend verifier
///         is mocked here; test/NotePoolProof.t.sol uses the generated one.
abstract contract KutleTest is Test {
    // Fixed so the fixture signatures (tools/fixtures/gen.mjs) match.
    address internal constant REGISTRY_ADDR = 0x00000000000000000000000000000000000D3c1E;
    address internal constant READING_LOG_ADDR = 0x000000000000000000000000000000000000106e;

    address internal admin = makeAddr("admin");
    address internal manufacturer = makeAddr("manufacturer");
    address internal grader = makeAddr("grader");
    address internal repurposer = makeAddr("repurposer");
    address internal authority = makeAddr("authority");
    address internal registrar = makeAddr("registrar");
    address internal secondLifeOperator = makeAddr("secondLifeOperator");

    uint256 internal recyclerKey = 0xA11CE;
    uint256 internal labKey = 0xB0B;
    address internal recycler;
    address internal lab;

    MLDSA44Verifier internal mldsa;
    IPoseidon2 internal poseidon;
    DeviceRegistry internal devices;
    ModelRegistry internal models;
    ReadingLog internal readings;
    PassportRegistry internal passports;
    ConservationLedger internal ledger;
    NotePool internal pool;
    MockSpendVerifier internal spendVerifier;

    string internal fx;
    bytes32 internal constant MODEL_ID = keccak256("kutle-soh-v1");

    function setUp() public virtual {
        recycler = vm.addr(recyclerKey);
        lab = vm.addr(labKey);
        fx = vm.readFile("test/fixtures/mldsa.json");
        vm.warp(vm.parseJsonUint(fx, ".t0"));

        address helper = deployRaw(vm.parseBytes(vm.readFile("test/fixtures/f1600_170.hex")));
        mldsa = new MLDSA44Verifier(helper);
        poseidon = IPoseidon2(address(new Poseidon2Yul_BN254()));

        deployCodeTo("DeviceRegistry.sol:DeviceRegistry", abi.encode(admin), REGISTRY_ADDR);
        devices = DeviceRegistry(REGISTRY_ADDR);
        models = new ModelRegistry(admin);
        passports = new PassportRegistry(admin, devices, models);
        deployCodeTo("ReadingLog.sol:ReadingLog", abi.encode(devices, passports), READING_LOG_ADDR);
        readings = ReadingLog(READING_LOG_ADDR);
        ledger = new ConservationLedger(admin, IPassportsForLedger(address(passports)));
        spendVerifier = new MockSpendVerifier();
        pool = new NotePool(poseidon, IShieldedSpendVerifier(address(spendVerifier)), IPassportsForNotes(address(passports)), address(ledger));

        vm.startPrank(admin);
        passports.wire(IReadingLog(address(readings)), ILedgerTaint(address(ledger)));
        ledger.setNotePool(INotePoolInsert(address(pool)));
        devices.setSuite(devices.SUITE_ECDSA_MLDSA44(), address(mldsa), true);
        devices.grantRole(devices.REGISTRAR_ROLE(), registrar);
        devices.grantRole(devices.AUTHORITY_ROLE(), authority);
        passports.grantRole(passports.MANUFACTURER_ROLE(), manufacturer);
        passports.grantRole(passports.GRADER_ROLE(), grader);
        passports.grantRole(passports.REPURPOSER_ROLE(), repurposer);
        passports.grantRole(passports.AUTHORITY_ROLE(), authority);
        passports.grantRole(passports.LEDGER_ROLE(), address(ledger));
        passports.grantRole(passports.NOTEPOOL_ROLE(), address(pool));
        ledger.grantRole(ledger.RECYCLER_ROLE(), recycler);
        ledger.setLab(lab, true, keccak256("ISO/IEC 17025 demo certificate"));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    /// Deploy raw runtime code with a 12-byte init stub that copies and returns it.
    function deployRaw(bytes memory runtime) internal returns (address a) {
        require(runtime.length < 0x10000, "too big");
        bytes memory init = abi.encodePacked(
            hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime
        );
        assembly {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0) && a.code.length == runtime.length, "deployRaw");
    }

    function fxBytes(string memory path) internal view returns (bytes memory) {
        return vm.parseJsonBytes(fx, path);
    }

    function fxAddr(string memory path) internal view returns (address) {
        return vm.parseJsonAddress(fx, path);
    }

    function fxB32(string memory path) internal view returns (bytes32) {
        return vm.parseJsonBytes32(fx, path);
    }

    function fxUint(string memory path) internal view returns (uint256) {
        return vm.parseJsonUint(fx, path);
    }

    /// Register a device from a fixture key ("keyA1", "keyB1", ...).
    function registerFixtureDevice(string memory k, bytes32 deviceId, address operator) internal {
        address blob = deployRaw(fxBytes(string.concat(".", k, ".blob")));
        vm.prank(registrar);
        devices.registerDevice(
            deviceId,
            operator,
            fxAddr(string.concat(".", k, ".ecdsaSigner")),
            fxBytes(string.concat(".", k, ".pk")),
            blob,
            fxBytes(string.concat(".", k, ".popEcdsa")),
            fxBytes(string.concat(".", k, ".popMldsa"))
        );
    }

    function deviceA() internal view returns (bytes32) {
        return fxB32(".deviceA");
    }

    function deviceB() internal view returns (bytes32) {
        return fxB32(".deviceB");
    }

    function defaultComposition() internal pure returns (uint64[4] memory c) {
        // A 60 kWh NMC811 pack, roughly: grams of Co, Li, Ni, Pb.
        c[0] = 4_500;
        c[1] = 6_000;
        c[2] = 36_000;
        c[3] = 0;
    }

    function issuePassport(bytes32 deviceId, bytes32 gs1) internal returns (uint256 id) {
        PassportRegistry.IssueParams memory p = PassportRegistry.IssueParams({
            deviceId: deviceId,
            category: 1,
            massGrams: 400_000,
            capacityWh: 60_000,
            composition: defaultComposition(),
            dataHash: keccak256(abi.encode("battery-pass-json", gs1)),
            gs1Hash: gs1,
            uri: "ipfs://passport"
        });
        vm.prank(manufacturer);
        id = passports.issue(p);
    }

    /// Device A registered to the manufacturer, passport #1 bound to it.
    function setUpDeviceAndPassport() internal returns (uint256 id) {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        id = issuePassport(deviceA(), keccak256("gs1:A"));
        assertEq(id, 1, "fixtures expect passport #1");
    }

    function anchorFixtureBatch(uint256 i) internal returns (bytes32) {
        string memory b = string.concat(".batches[", vm.toString(i), "]");
        return readings.anchor(
            fxB32(string.concat(b, ".deviceId")),
            fxUint(string.concat(b, ".passportId")),
            uint64(fxUint(string.concat(b, ".seq"))),
            fxB32(string.concat(b, ".root")),
            uint64(fxUint(string.concat(b, ".fromTs"))),
            uint64(fxUint(string.concat(b, ".toTs"))),
            uint32(fxUint(string.concat(b, ".count"))),
            fxBytes(string.concat(b, ".ecdsaSig")),
            fxBytes(string.concat(b, ".mldsaSig"))
        );
    }

    function registerModel() internal {
        ModelRegistry.Model memory m = ModelRegistry.Model({
            weightsHash: keccak256("weights"),
            evalDataHash: keccak256("eval"),
            codeHash: keccak256("code"),
            maeBps: 150,
            baselineMaeBps: 320,
            coverageBps: 9_000,
            registeredAt: 0,
            active: false,
            uri: "ipfs://model-card"
        });
        vm.prank(admin);
        models.register(MODEL_ID, m);
    }
}
