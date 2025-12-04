pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract LegalAgreementFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidAddress();
    error InvalidCooldown();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool closed;
    }
    Batch public currentBatch;

    struct Agreement {
        euint32 price;
        euint32 deliveryDate;
        euint32 penaltyRate;
        ebool isActive;
    }
    mapping(uint256 => Agreement) public agreements;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event AgreementSubmitted(address indexed provider, uint256 indexed batchId, uint256 agreementId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalActiveAgreements);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown(address _address) {
        if (block.timestamp < lastSubmissionTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown(address _address) {
        if (block.timestamp < lastDecryptionRequestTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        cooldownSeconds = 60;
        currentBatch = Batch({id: 0, closed: false});
        emit BatchOpened(0);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidAddress();
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidAddress();
        delete providers[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit ContractPaused(msg.sender);
        } else {
            paused = false;
            emit ContractUnpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidCooldown();
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.closed) revert BatchNotClosed();
        uint256 newBatchId = currentBatch.id + 1;
        currentBatch = Batch({id: newBatchId, closed: false});
        emit BatchOpened(newBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (currentBatch.closed) revert BatchClosed();
        currentBatch.closed = true;
        emit BatchClosed(currentBatch.id);
    }

    function submitAgreement(
        euint32 _price,
        euint32 _deliveryDate,
        euint32 _penaltyRate
    ) external onlyProvider whenNotPaused checkSubmissionCooldown(msg.sender) {
        _initIfNeeded(_price);
        _initIfNeeded(_deliveryDate);
        _initIfNeeded(_penaltyRate);

        uint256 agreementId = uint256(keccak256(abi.encodePacked(msg.sender, currentBatch.id, agreementsCount)));
        agreements[agreementId] = Agreement({
            price: _price,
            deliveryDate: _deliveryDate,
            penaltyRate: _penaltyRate,
            isActive: ebool(true)
        });
        agreementsCount++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit AgreementSubmitted(msg.sender, currentBatch.id, agreementId);
    }

    function requestBatchSummary() external onlyProvider whenNotPaused checkDecryptionCooldown(msg.sender) {
        if (!currentBatch.closed) revert BatchNotClosed();

        uint256 requestId = FHE.requestDecryption(_prepareCiphertextsForBatchSummary(), this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatch.id,
            stateHash: _hashCiphertexts(_prepareCiphertextsForBatchSummary()),
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatch.id, decryptionContexts[requestId].stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        bytes32 currentHash = _hashCiphertexts(_prepareCiphertextsForBatchSummary());
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256 totalActiveAgreements = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalActiveAgreements);
    }

    function _prepareCiphertextsForBatchSummary() internal view returns (bytes32[] memory) {
        euint32 totalActive = euint32(0);
        for (uint256 i = 0; i < agreementsCount; i++) {
            if (agreements[i].isActive) {
                totalActive = totalActive.add(1);
            }
        }
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(totalActive);
        return cts;
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!value.isInitialized()) revert NotInitialized();
    }

    function _requireInitialized(euint32 value) internal pure {
        if (!value.isInitialized()) revert NotInitialized();
    }

    uint256 agreementsCount;
}