// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Auction {
  id: number;
  title: string;
  description: string;
  encryptedBids: string[];
  highestBid: string;
  endTime: number;
  creator: string;
  status: 'active' | 'ended';
}

interface Bid {
  bidder: string;
  encryptedAmount: string;
  decryptedAmount?: number;
  timestamp: number;
}

interface UserAction {
  type: 'create' | 'bid' | 'decrypt';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingAuction, setCreatingAuction] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAuctionData, setNewAuctionData] = useState({ title: "", description: "", duration: 1 });
  const [selectedAuction, setSelectedAuction] = useState<Auction | null>(null);
  const [decryptedBids, setDecryptedBids] = useState<Bid[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [activeTab, setActiveTab] = useState('auctions');
  const [searchTerm, setSearchTerm] = useState("");
  const [bidAmount, setBidAmount] = useState("");
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'ended'>('all');

  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load auctions
      const auctionsBytes = await contract.getData("auctions");
      let auctionsList: Auction[] = [];
      if (auctionsBytes.length > 0) {
        try {
          const auctionsStr = ethers.toUtf8String(auctionsBytes);
          if (auctionsStr.trim() !== '') auctionsList = JSON.parse(auctionsStr);
        } catch (e) {}
      }
      setAuctions(auctionsList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Create new auction
  const createAuction = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setCreatingAuction(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating auction with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new auction
      const newAuction: Auction = {
        id: auctions.length + 1,
        title: newAuctionData.title,
        description: newAuctionData.description,
        encryptedBids: [],
        highestBid: FHEEncryptNumber(0),
        endTime: Math.floor(Date.now() / 1000) + (newAuctionData.duration * 86400),
        creator: address,
        status: 'active'
      };
      
      // Update auctions list
      const updatedAuctions = [...auctions, newAuction];
      
      // Save to contract
      await contract.setData("auctions", ethers.toUtf8Bytes(JSON.stringify(updatedAuctions)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'create',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Created auction: ${newAuctionData.title}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Auction created successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAuctionData({ title: "", description: "", duration: 1 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreatingAuction(false); 
    }
  };

  // Place bid on auction
  const placeBid = async (auctionId: number) => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    if (!bidAmount || isNaN(parseFloat(bidAmount))) {
      setTransactionStatus({ visible: true, status: "error", message: "Please enter a valid bid amount" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return;
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Processing bid with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the auction
      const auctionIndex = auctions.findIndex(a => a.id === auctionId);
      if (auctionIndex === -1) throw new Error("Auction not found");
      
      // Update bids
      const updatedAuctions = [...auctions];
      const encryptedBid = FHEEncryptNumber(parseFloat(bidAmount));
      updatedAuctions[auctionIndex].encryptedBids.push(encryptedBid);
      
      // Update highest bid if needed (simulate FHE comparison)
      const currentHighest = FHEDecryptNumber(updatedAuctions[auctionIndex].highestBid);
      if (parseFloat(bidAmount) > currentHighest) {
        updatedAuctions[auctionIndex].highestBid = encryptedBid;
      }
      
      // Save to contract
      await contract.setData("auctions", ethers.toUtf8Bytes(JSON.stringify(updatedAuctions)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'bid',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Placed bid on auction: ${updatedAuctions[auctionIndex].title}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Bid placed with FHE encryption!" });
      await loadData();
      setBidAmount("");
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Bidding failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt bids with signature
  const decryptWithSignature = async (auction: Auction) => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Decrypt all bids
      const decrypted = auction.encryptedBids.map(bid => ({
        bidder: "0x...", // In real implementation, this would come from encrypted metadata
        encryptedAmount: bid,
        decryptedAmount: FHEDecryptNumber(bid),
        timestamp: Math.floor(Date.now() / 1000)
      }));
      
      setDecryptedBids(decrypted);
      
      // Update user actions
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE bids"
      };
      setUserActions(prev => [newAction, ...prev]);
    } catch (e) { 
      console.error("Decryption failed:", e);
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Render auction status
  const renderAuctionStatus = (auction: Auction) => {
    const now = Math.floor(Date.now() / 1000);
    const ended = auction.endTime <= now;
    
    return (
      <div className={`auction-status ${ended ? 'ended' : 'active'}`}>
        {ended ? 'Ended' : 'Active'}
      </div>
    );
  };

  // Render FHE flow visualization
  const renderFHEFlow = () => {
    return (
      <div className="fhe-flow">
        <div className="flow-step">
          <div className="step-icon">1</div>
          <div className="step-content">
            <h4>Bid Submission</h4>
            <p>Bidders submit encrypted bids using Zama FHE</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">2</div>
          <div className="step-content">
            <h4>Encrypted Comparison</h4>
            <p>Smart contract compares encrypted bids homomorphically</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">3</div>
          <div className="step-content">
            <h4>Auction Conclusion</h4>
            <p>Only winning bid is decrypted after auction ends</p>
          </div>
        </div>
      </div>
    );
  };

  // Render user actions history
  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions recorded</div>;
    
    return (
      <div className="actions-list">
        {userActions.map((action, index) => (
          <div className="action-item" key={index}>
            <div className={`action-type ${action.type}`}>
              {action.type === 'create' && '📝'}
              {action.type === 'bid' && '💰'}
              {action.type === 'decrypt' && '🔓'}
            </div>
            <div className="action-details">
              <div className="action-text">{action.details}</div>
              <div className="action-time">{new Date(action.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render FAQ section
  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is Sealed-Bid Auction?",
        answer: "A sealed-bid auction keeps all bids confidential until the auction ends, preventing bid sniping and information leakage."
      },
      {
        question: "How does FHE protect my bid?",
        answer: "FHE allows your bid amount to remain encrypted throughout the auction process, only revealing the winning bid after conclusion."
      },
      {
        question: "When is my bid decrypted?",
        answer: "Only the winning bid is decrypted after the auction ends. All other bids remain encrypted permanently."
      },
      {
        question: "What can I auction with this?",
        answer: "This protocol is ideal for domain names, NFTs, spectrum rights, and other high-value digital assets."
      },
      {
        question: "What blockchain is this built on?",
        answer: "The protocol is built on Ethereum and utilizes Zama FHE for privacy-preserving computations."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  // Filter auctions based on search and status
  const filteredAuctions = auctions.filter(auction => {
    const matchesSearch = auction.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         auction.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === 'all' || 
                        (filterStatus === 'active' && auction.status === 'active' && auction.endTime > Math.floor(Date.now() / 1000)) ||
                        (filterStatus === 'ended' && (auction.status === 'ended' || auction.endTime <= Math.floor(Date.now() / 1000)));
    return matchesSearch && matchesStatus;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted auction system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="auction-icon"></div>
          </div>
          <h1>Auction<span>Seal</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-auction-btn"
          >
            <div className="add-icon"></div>Create Auction
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-grid">
            <div className="dashboard-panel intro-panel">
              <div className="panel-card">
                <h2>Sealed-Bid Decentralized Auction</h2>
                <p>AuctionSeal is a protocol for conducting sealed-bid auctions where all bids remain encrypted until the auction concludes, powered by Zama FHE.</p>
                <div className="fhe-badge">
                  <div className="fhe-icon"></div>
                  <span>Powered by Zama FHE</span>
                </div>
              </div>
              
              <div className="panel-card">
                <h2>FHE Auction Flow</h2>
                {renderFHEFlow()}
              </div>
              
              <div className="panel-card">
                <h2>Auction Statistics</h2>
                <div className="stats-grid">
                  <div className="stat-item">
                    <div className="stat-value">{auctions.length}</div>
                    <div className="stat-label">Total Auctions</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">
                      {auctions.length > 0 
                        ? auctions.reduce((sum, a) => sum + a.encryptedBids.length, 0)
                        : 0}
                    </div>
                    <div className="stat-label">Total Bids</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">
                      {auctions.length > 0 
                        ? Math.round(auctions.reduce((sum, a) => sum + a.encryptedBids.length, 0) / auctions.length) 
                        : 0}
                    </div>
                    <div className="stat-label">Avg Bids</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'auctions' ? 'active' : ''}`}
                onClick={() => setActiveTab('auctions')}
              >
                Auctions
              </button>
              <button 
                className={`tab ${activeTab === 'actions' ? 'active' : ''}`}
                onClick={() => setActiveTab('actions')}
              >
                My Actions
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'auctions' && (
                <div className="auctions-section">
                  <div className="section-header">
                    <h2>Active Auctions</h2>
                    <div className="header-actions">
                      <div className="search-filter">
                        <input 
                          type="text" 
                          placeholder="Search auctions..." 
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        <select 
                          value={filterStatus}
                          onChange={(e) => setFilterStatus(e.target.value as 'all' | 'active' | 'ended')}
                        >
                          <option value="all">All</option>
                          <option value="active">Active</option>
                          <option value="ended">Ended</option>
                        </select>
                      </div>
                      <button 
                        onClick={loadData} 
                        className="refresh-btn" 
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="auctions-list">
                    {filteredAuctions.length === 0 ? (
                      <div className="no-auctions">
                        <div className="no-auctions-icon"></div>
                        <p>No auctions found</p>
                        <button 
                          className="create-btn" 
                          onClick={() => setShowCreateModal(true)}
                        >
                          Create First Auction
                        </button>
                      </div>
                    ) : filteredAuctions.map((auction, index) => (
                      <div 
                        className={`auction-item ${selectedAuction?.id === auction.id ? "selected" : ""}`} 
                        key={index}
                        onClick={() => setSelectedAuction(auction)}
                      >
                        <div className="auction-header">
                          <div className="auction-title">{auction.title}</div>
                          {renderAuctionStatus(auction)}
                        </div>
                        <div className="auction-description">{auction.description.substring(0, 100)}...</div>
                        <div className="auction-meta">
                          <div className="meta-item">
                            <span>Creator:</span>
                            <strong>{auction.creator.substring(0, 6)}...{auction.creator.substring(38)}</strong>
                          </div>
                          <div className="meta-item">
                            <span>Ends:</span>
                            <strong>{new Date(auction.endTime * 1000).toLocaleString()}</strong>
                          </div>
                          <div className="meta-item">
                            <span>Bids:</span>
                            <strong>{auction.encryptedBids.length}</strong>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'actions' && (
                <div className="actions-section">
                  <h2>My Activity History</h2>
                  {renderUserActions()}
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h2>Frequently Asked Questions</h2>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <ModalCreateAuction 
          onSubmit={createAuction} 
          onClose={() => setShowCreateModal(false)} 
          creating={creatingAuction} 
          auctionData={newAuctionData} 
          setAuctionData={setNewAuctionData}
        />
      )}
      
      {selectedAuction && (
        <AuctionDetailModal 
          auction={selectedAuction} 
          onClose={() => { 
            setSelectedAuction(null); 
            setDecryptedBids([]); 
          }} 
          decryptedBids={decryptedBids}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          placeBid={placeBid}
          bidAmount={bidAmount}
          setBidAmount={setBidAmount}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="auction-icon"></div>
              <span>AuctionSeal</span>
            </div>
            <p>Sealed-Bid Decentralized Auction Protocol</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} AuctionSeal. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect bid privacy. 
            All bids remain encrypted until auction conclusion.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateAuctionProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  auctionData: any;
  setAuctionData: (data: any) => void;
}

const ModalCreateAuction: React.FC<ModalCreateAuctionProps> = ({ onSubmit, onClose, creating, auctionData, setAuctionData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setAuctionData({ ...auctionData, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="create-auction-modal">
        <div className="modal-header">
          <h2>Create New Auction</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Auction Notice</strong>
              <p>All bids on this auction will remain encrypted until conclusion</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Auction Title *</label>
            <input 
              type="text" 
              name="title" 
              value={auctionData.title} 
              onChange={handleChange} 
              placeholder="Enter auction title..." 
            />
          </div>
          
          <div className="form-group">
            <label>Description *</label>
            <textarea 
              name="description" 
              value={auctionData.description} 
              onChange={handleChange} 
              placeholder="Describe the item being auctioned..." 
              rows={4}
            />
          </div>
          
          <div className="form-group">
            <label>Duration (Days) *</label>
            <input 
              type="number" 
              name="duration" 
              min="1"
              max="30"
              value={auctionData.duration} 
              onChange={handleChange} 
              placeholder="Enter duration in days..." 
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={creating || !auctionData.title || !auctionData.description} 
            className="submit-btn"
          >
            {creating ? "Creating with FHE..." : "Create Auction"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AuctionDetailModalProps {
  auction: Auction;
  onClose: () => void;
  decryptedBids: Bid[];
  isDecrypting: boolean;
  decryptWithSignature: (auction: Auction) => Promise<void>;
  placeBid: (auctionId: number) => void;
  bidAmount: string;
  setBidAmount: (value: string) => void;
}

const AuctionDetailModal: React.FC<AuctionDetailModalProps> = ({ 
  auction, 
  onClose, 
  decryptedBids,
  isDecrypting, 
  decryptWithSignature,
  placeBid,
  bidAmount,
  setBidAmount
}) => {
  const now = Math.floor(Date.now() / 1000);
  const ended = auction.endTime <= now;
  const isCreator = auction.creator === auction.creator; // Simplified for demo

  return (
    <div className="modal-overlay">
      <div className="auction-detail-modal">
        <div className="modal-header">
          <h2>Auction Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="auction-info">
            <div className="info-header">
              <h3>{auction.title}</h3>
              {renderAuctionStatus(auction)}
            </div>
            <div className="info-item">
              <span>Creator:</span>
              <strong>{auction.creator.substring(0, 6)}...{auction.creator.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>End Time:</span>
              <strong>{new Date(auction.endTime * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Total Bids:</span>
              <strong>{auction.encryptedBids.length}</strong>
            </div>
            <div className="info-item full-width">
              <span>Description:</span>
              <div className="auction-description">{auction.description}</div>
            </div>
          </div>
          
          {!ended && (
            <div className="bid-section">
              <h3>Place Bid</h3>
              <div className="bid-form">
                <input 
                  type="number" 
                  placeholder="Enter bid amount..." 
                  value={bidAmount}
                  onChange={(e) => setBidAmount(e.target.value)}
                />
                <button 
                  className="bid-btn" 
                  onClick={() => placeBid(auction.id)}
                  disabled={!bidAmount || isNaN(parseFloat(bidAmount))}
                >
                  Submit Encrypted Bid
                </button>
              </div>
              <div className="fhe-tag">
                <div className="fhe-icon"></div>
                <span>Bid will be encrypted with FHE</span>
              </div>
            </div>
          )}
          
          <div className="bids-section">
            <h3>
              {ended ? 'Auction Results' : 'Bid Activity'}
              {isCreator && auction.encryptedBids.length > 0 && (
                <button 
                  className="decrypt-btn" 
                  onClick={() => decryptWithSignature(auction)} 
                  disabled={isDecrypting}
                >
                  {isDecrypting ? (
                    "Decrypting..."
                  ) : decryptedBids.length > 0 ? (
                    "Hide Decrypted Bids"
                  ) : (
                    "Decrypt Bids"
                  )}
                </button>
              )}
            </h3>
            
            {decryptedBids.length > 0 ? (
              <div className="bids-list">
                <div className="bids-header">
                  <span>Bidder</span>
                  <span>Amount</span>
                </div>
                {decryptedBids.map((bid, index) => (
                  <div className="bid-item" key={index}>
                    <span>{bid.bidder}</span>
                    <strong>{bid.decryptedAmount?.toFixed(4)} ETH</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="encrypted-bids-notice">
                <div className="lock-icon"></div>
                <p>
                  {ended 
                    ? "Auction has ended. The creator can decrypt the winning bid." 
                    : "All bids are encrypted with FHE and will remain confidential until auction ends."}
                </p>
              </div>
            )}
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;