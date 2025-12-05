pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AuctionSealFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Bid {
        address bidder;
        euint32 encryptedBidAmount;
    }
    Bid[] public bids;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event BidSubmitted(address indexed bidder, uint256 batchId, euint32 encryptedBidAmount);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event AuctionSettled(uint256 indexed requestId, uint256 batchId, address winner, uint256 winningBidAmount);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchNotOpen();
    error NoBidsInBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error BidSubmissionFailed();
    error DecryptionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner is zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        require(newCooldownSeconds > 0, "Cooldown must be positive");
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        bids = new Bid[](0); // Reset bids array for the new batch
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitBid(euint32 encryptedBidAmount) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();
        if (!encryptedBidAmount.isInitialized()) revert BidSubmissionFailed();

        lastSubmissionTime[msg.sender] = block.timestamp;
        bids.push(Bid(msg.sender, encryptedBidAmount));
        emit BidSubmitted(msg.sender, currentBatchId, encryptedBidAmount);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded() internal {
        euint32(0); // Ensures FHE library is initialized if not already
    }

    function _requireInitialized(euint32 v) internal pure {
        if (!v.isInitialized()) revert BidSubmissionFailed();
    }
    function _requireInitialized(ebool b) internal pure {
        if (!b.isInitialized()) revert BidSubmissionFailed();
    }

    function findHighestBidder() external onlyOwner whenNotPaused checkDecryptionCooldown {
        if (bids.length == 0) revert NoBidsInBatch();

        euint32 maxBid = bids[0].encryptedBidAmount;
        address winner = bids[0].bidder;

        for (uint i = 1; i < bids.length; i++) {
            ebool isGreater = bids[i].encryptedBidAmount.ge(maxBid);
            euint32 newMax = FHE.select(bids[i].encryptedBidAmount, maxBid, isGreater);
            address newWinner = isGreater ? bids[i].bidder : winner;
            maxBid = newMax;
            winner = newWinner;
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = maxBid.toBytes32();
        cts[1] = keccak256(abi.encode(winner)); // Store hash of winner's address

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild cts from current contract storage in the exact same order as in findHighestBidder
        if (bids.length == 0) revert NoBidsInBatch(); // Should not happen if findHighestBidder was called

        euint32 maxBid = bids[0].encryptedBidAmount;
        address winner = bids[0].bidder;
        for (uint i = 1; i < bids.length; i++) {
            ebool isGreater = bids[i].encryptedBidAmount.ge(maxBid);
            euint32 newMax = FHE.select(bids[i].encryptedBidAmount, maxBid, isGreater);
            address newWinner = isGreater ? bids[i].bidder : winner;
            maxBid = newMax;
            winner = newWinner;
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = maxBid.toBytes32();
        cts[1] = keccak256(abi.encode(winner));

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            // Decode cleartexts in the same order
            uint32 winningBidAmount = abi.decode(cleartexts, (uint32));
            // The second cleartext is the hash of the winner's address, not the address itself.
            // We already have the 'winner' address from the loop above.

            decryptionContexts[requestId].processed = true;
            emit AuctionSettled(requestId, decryptionContexts[requestId].batchId, winner, winningBidAmount);
        } catch {
            revert InvalidProof();
        }
    }
}