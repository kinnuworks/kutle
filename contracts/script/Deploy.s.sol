// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MLDSA44Verifier} from "mldsa/MLDSA44Verifier.sol";
import {Poseidon2Yul_BN254} from "poseidon2/bn254/yul/Poseidon2Yul.sol";
import {IPoseidon2} from "poseidon2/IPoseidon2.sol";

import {KutleCouncil} from "../src/governance/KutleCouncil.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {ReadingLog, IPassportDevice} from "../src/ReadingLog.sol";
import {PassportRegistry, IReadingLog, ILedgerTaint} from "../src/PassportRegistry.sol";
import {ConservationLedger, IPassportsForLedger, INotePoolInsert} from "../src/ConservationLedger.sol";
import {NotePool, IShieldedSpendVerifier, IPassportsForNotes} from "../src/NotePool.sol";
import {ShieldedSpendVerifier} from "../src/verifiers/ShieldedSpendVerifier.sol";

/// Deploys the whole system, wires it, grants the demo operators their roles,
/// then hands every admin role to the timelock and renounces the deployer's.
/// After this script the deployer key controls nothing.
///
///   FOUNDRY_PROFILE=script forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
///
/// Environment:
///   DEPLOYER_KEY                 private key paying for deployment
///   COUNCIL_1, COUNCIL_2, COUNCIL_3   council members (2 of 3 approve)
///   TIMELOCK_DELAY               seconds, default 3600
///   MANUFACTURER, GRADER, REPURPOSER, AUTHORITY, REGISTRAR, RECYCLER, LAB
///   POSEIDON2                    optional: an existing Poseidon2Yul_BN254 deployment
contract Deploy is Script {
    /// keccak256 of the Keccak-f[1600] helper runtime the verifier pins.
    bytes32 internal constant F1600_CODEHASH = 0x4afb4435879cdf8e50474c7aab2bc3a679caed432550ad6dba64f509309a817b;

    struct Deployed {
        address f1600Helper;
        address mldsaVerifier;
        address poseidon2;
        address council;
        address timelock;
        address devices;
        address models;
        address passports;
        address readings;
        address ledger;
        address spendVerifier;
        address notePool;
    }

    function run() external returns (Deployed memory d) {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(key);
        vm.startBroadcast(key);

        d.f1600Helper = _deployRaw(vm.parseBytes(vm.readFile("lib/evm-ml-dsa-verifier/helpers/f1600_170.hex")));
        require(d.f1600Helper.codehash == F1600_CODEHASH, "helper code hash");
        d.mldsaVerifier = address(new MLDSA44Verifier(d.f1600Helper));

        address existing = vm.envOr("POSEIDON2", address(0));
        d.poseidon2 = existing.code.length > 0 ? existing : address(new Poseidon2Yul_BN254());

        address[] memory members = new address[](3);
        members[0] = vm.envAddress("COUNCIL_1");
        members[1] = vm.envAddress("COUNCIL_2");
        members[2] = vm.envAddress("COUNCIL_3");
        d.council = address(new KutleCouncil(members, 2));
        address[] memory council = new address[](1);
        council[0] = d.council;
        d.timelock = address(new TimelockController(vm.envOr("TIMELOCK_DELAY", uint256(3600)), council, council, address(0)));

        DeviceRegistry devices = new DeviceRegistry(deployer);
        ModelRegistry models = new ModelRegistry(deployer);
        PassportRegistry passports = new PassportRegistry(deployer, devices, models);
        ReadingLog readings = new ReadingLog(devices, IPassportDevice(address(passports)));
        ConservationLedger ledger = new ConservationLedger(deployer, IPassportsForLedger(address(passports)));
        d.spendVerifier = address(new ShieldedSpendVerifier());
        NotePool pool = new NotePool(
            IPoseidon2(d.poseidon2), IShieldedSpendVerifier(d.spendVerifier), IPassportsForNotes(address(passports)), address(ledger)
        );
        d.devices = address(devices);
        d.models = address(models);
        d.passports = address(passports);
        d.readings = address(readings);
        d.ledger = address(ledger);
        d.notePool = address(pool);

        // Wiring.
        passports.wire(IReadingLog(address(readings)), ILedgerTaint(address(ledger)));
        ledger.setNotePool(INotePoolInsert(address(pool)));
        devices.setSuite(devices.SUITE_ECDSA_MLDSA44(), d.mldsaVerifier, true);
        passports.grantRole(passports.LEDGER_ROLE(), address(ledger));
        passports.grantRole(passports.NOTEPOOL_ROLE(), address(pool));

        // Demo operators.
        devices.grantRole(devices.REGISTRAR_ROLE(), vm.envAddress("REGISTRAR"));
        devices.grantRole(devices.AUTHORITY_ROLE(), vm.envAddress("AUTHORITY"));
        passports.grantRole(passports.MANUFACTURER_ROLE(), vm.envAddress("MANUFACTURER"));
        passports.grantRole(passports.GRADER_ROLE(), vm.envAddress("GRADER"));
        passports.grantRole(passports.REPURPOSER_ROLE(), vm.envAddress("REPURPOSER"));
        passports.grantRole(passports.AUTHORITY_ROLE(), vm.envAddress("AUTHORITY"));
        ledger.grantRole(ledger.RECYCLER_ROLE(), vm.envAddress("RECYCLER"));
        ledger.setLab(vm.envAddress("LAB"), true, keccak256("demo lab, ISO/IEC 17025 certificate reference"));

        // Hand over: the timelock becomes the only admin, the deployer leaves.
        _handOver(address(devices), d.timelock, deployer);
        _handOver(address(models), d.timelock, deployer);
        _handOver(address(passports), d.timelock, deployer);
        _handOver(address(ledger), d.timelock, deployer);

        vm.stopBroadcast();
        _write(d);
    }

    function _handOver(address target, address timelock, address deployer) internal {
        bytes32 admin = 0x00; // DEFAULT_ADMIN_ROLE
        IAccessControlLike(target).grantRole(admin, timelock);
        IAccessControlLike(target).renounceRole(admin, deployer);
        require(!IAccessControlLike(target).hasRole(admin, deployer), "deployer still admin");
    }

    function _deployRaw(bytes memory runtime) internal returns (address a) {
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly ("memory-safe") {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0) && a.code.length == runtime.length, "deployRaw");
    }

    function _write(Deployed memory d) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "f1600Helper", d.f1600Helper);
        vm.serializeAddress(k, "mldsaVerifier", d.mldsaVerifier);
        vm.serializeAddress(k, "poseidon2", d.poseidon2);
        vm.serializeAddress(k, "council", d.council);
        vm.serializeAddress(k, "timelock", d.timelock);
        vm.serializeAddress(k, "deviceRegistry", d.devices);
        vm.serializeAddress(k, "modelRegistry", d.models);
        vm.serializeAddress(k, "passportRegistry", d.passports);
        vm.serializeAddress(k, "readingLog", d.readings);
        vm.serializeAddress(k, "conservationLedger", d.ledger);
        vm.serializeAddress(k, "shieldedSpendVerifier", d.spendVerifier);
        string memory json = vm.serializeAddress(k, "notePool", d.notePool);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}

interface IAccessControlLike {
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
}
