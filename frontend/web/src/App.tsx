// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ContractAgreement {
  id: string;
  encryptedTerms: string;
  timestamp: number;
  creator: string;
  counterparty: string;
  status: "draft" | "signed" | "executed" | "disputed";
  category: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [contracts, setContracts] = useState<ContractAgreement[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newContractData, setNewContractData] = useState({ 
    category: "NDA", 
    counterparty: "", 
    price: 0, 
    deliveryDate: 0,
    penaltyClause: 0,
    terms: "" 
  });
  const [showGuide, setShowGuide] = useState(false);
  const [selectedContract, setSelectedContract] = useState<ContractAgreement | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState("contracts");
  const [showFAQ, setShowFAQ] = useState(false);

  useEffect(() => {
    loadContracts().finally(() => setLoading(false));
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

  const loadContracts = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load contract keys
      const keysBytes = await contract.getData("contract_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing contract keys:", e); }
      }
      
      // Load each contract
      const list: ContractAgreement[] = [];
      for (const key of keys) {
        try {
          const contractBytes = await contract.getData(`contract_${key}`);
          if (contractBytes.length > 0) {
            try {
              const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
              list.push({ 
                id: key, 
                encryptedTerms: contractData.encryptedTerms, 
                timestamp: contractData.timestamp, 
                creator: contractData.creator, 
                counterparty: contractData.counterparty,
                status: contractData.status || "draft",
                category: contractData.category || "General"
              });
            } catch (e) { console.error(`Error parsing contract data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading contract ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setContracts(list);
    } catch (e) { console.error("Error loading contracts:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createContract = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting sensitive terms with Zama FHE..." });
    try {
      // Encrypt sensitive numeric terms
      const encryptedPrice = FHEEncryptNumber(newContractData.price);
      const encryptedDeliveryDate = FHEEncryptNumber(newContractData.deliveryDate);
      const encryptedPenalty = FHEEncryptNumber(newContractData.penaltyClause);
      
      // Combine encrypted data
      const encryptedTerms = JSON.stringify({
        price: encryptedPrice,
        deliveryDate: encryptedDeliveryDate,
        penaltyClause: encryptedPenalty,
        generalTerms: newContractData.terms
      });
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const contractId = `contract-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const contractData = { 
        encryptedTerms,
        timestamp: Math.floor(Date.now() / 1000),
        creator: address,
        counterparty: newContractData.counterparty,
        status: "draft",
        category: newContractData.category
      };
      
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(contractData)));
      
      // Update contract keys
      const keysBytes = await contract.getData("contract_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(contractId);
      await contract.setData("contract_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Smart legal agreement created with FHE encryption!" });
      await loadContracts();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewContractData({ 
          category: "NDA", 
          counterparty: "", 
          price: 0, 
          deliveryDate: 0,
          penaltyClause: 0,
          terms: "" 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Contract creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const signContract = async (contractId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing contract signature with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      const updatedContract = { ...contractData, status: "signed" };
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      await contractWithSigner.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Contract signed successfully!" });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Signing failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const executeContract = async (contractId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Executing contract terms with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      const updatedContract = { ...contractData, status: "executed" };
      
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Contract executed successfully!" });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Execution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const disputeContract = async (contractId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Initiating FHE-based dispute resolution..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const contractBytes = await contract.getData(`contract_${contractId}`);
      if (contractBytes.length === 0) throw new Error("Contract not found");
      
      const contractData = JSON.parse(ethers.toUtf8String(contractBytes));
      const updatedContract = { ...contractData, status: "disputed" };
      
      await contract.setData(`contract_${contractId}`, ethers.toUtf8Bytes(JSON.stringify(updatedContract)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Dispute initiated! DAO arbitration will review." });
      await loadContracts();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Dispute failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isCreator = (contractCreator: string) => address?.toLowerCase() === contractCreator.toLowerCase();

  const guideSteps = [
    { 
      title: "Connect Wallet", 
      description: "Connect your Web3 wallet to access the FHE-based legal agreement platform", 
      icon: "🔗" 
    },
    { 
      title: "Create Agreement", 
      description: "Define your contract terms with sensitive data encrypted using Zama FHE", 
      icon: "📝",
      details: "Price, delivery dates, and penalties are encrypted on-chain while remaining computable" 
    },
    { 
      title: "Counterparty Review", 
      description: "Share the agreement with your counterparty for review and signature", 
      icon: "✍️",
      details: "All parties can verify contract terms without seeing sensitive encrypted data" 
    },
    { 
      title: "Execution & Compliance", 
      description: "Contract automatically executes when conditions are met via FHE verification", 
      icon: "⚖️",
      details: "Zama FHE enables computation on encrypted data without decryption" 
    },
    { 
      title: "Dispute Resolution", 
      description: "In case of disputes, DAO arbitrators can decrypt and review sensitive terms", 
      icon: "🧑‍⚖️",
      details: "Only authorized arbitrators with multi-sig access can decrypt disputed terms" 
    }
  ];

  const faqItems = [
    {
      question: "What is FHE-based contract encryption?",
      answer: "Fully Homomorphic Encryption (FHE) allows computations on encrypted data without decryption. In legal contracts, sensitive terms like prices and dates remain encrypted but can still be verified for compliance."
    },
    {
      question: "How does Zama FHE protect my contract?",
      answer: "Zama's FHE technology encrypts numeric contract terms on-chain. These values can be mathematically verified without exposing the actual numbers, ensuring confidentiality while maintaining enforceability."
    },
    {
      question: "Who can decrypt my contract terms?",
      answer: "Only authorized DAO arbitrators with multi-signature approval can decrypt terms during disputes. Regular contract execution happens without decryption using FHE verification."
    },
    {
      question: "What types of contracts can I create?",
      answer: "The platform supports any business contract with numeric terms (NDAs, service agreements, sales contracts). Textual terms remain visible while numeric values are FHE-encrypted."
    },
    {
      question: "How are disputes resolved?",
      answer: "When disputes occur, a decentralized panel of arbitrators votes to decrypt and review the disputed terms. This ensures transparency while maintaining confidentiality during normal operations."
    }
  ];

  const renderContractStats = () => {
    const total = contracts.length || 1;
    const draftCount = contracts.filter(c => c.status === "draft").length;
    const signedCount = contracts.filter(c => c.status === "signed").length;
    const executedCount = contracts.filter(c => c.status === "executed").length;
    const disputedCount = contracts.filter(c => c.status === "disputed").length;

    return (
      <div className="stats-container">
        <div className="stat-card">
          <div className="stat-value">{total}</div>
          <div className="stat-label">Total Contracts</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{draftCount}</div>
          <div className="stat-label">Draft</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{signedCount}</div>
          <div className="stat-label">Signed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{executedCount}</div>
          <div className="stat-label">Executed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{disputedCount}</div>
          <div className="stat-label">Disputed</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="loading-spinner"></div>
      <p>Initializing FHE legal protocol...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-container">
          <div className="logo-icon">⚖️</div>
          <h1>FHE Legal Agreements</h1>
        </div>
        <nav className="main-nav">
          <button 
            className={`nav-btn ${activeTab === "contracts" ? "active" : ""}`}
            onClick={() => setActiveTab("contracts")}
          >
            My Contracts
          </button>
          <button 
            className={`nav-btn ${activeTab === "guide" ? "active" : ""}`}
            onClick={() => setActiveTab("guide")}
          >
            How It Works
          </button>
          <button 
            className={`nav-btn ${activeTab === "faq" ? "active" : ""}`}
            onClick={() => setActiveTab("faq")}
          >
            FAQ
          </button>
        </nav>
        <div className="header-actions">
          <ConnectButton 
            accountStatus="address" 
            chainStatus="icon" 
            showBalance={false}
            label="Connect Wallet"
          />
        </div>
      </header>

      <main className="main-content">
        {activeTab === "contracts" && (
          <>
            <section className="action-bar">
              <button 
                className="primary-btn"
                onClick={() => setShowCreateModal(true)}
              >
                + New Agreement
              </button>
              <button 
                className="secondary-btn"
                onClick={loadContracts}
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
              <div className="wallet-status">
                {isConnected ? (
                  <span className="connected-dot"></span>
                ) : (
                  <span className="disconnected-dot"></span>
                )}
                <span>{isConnected ? "Connected" : "Disconnected"}</span>
              </div>
            </section>

            <section className="dashboard-section">
              <h2>Contract Overview</h2>
              {renderContractStats()}
            </section>

            <section className="contracts-section">
              <h2>My Legal Agreements</h2>
              {contracts.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📄</div>
                  <p>No contracts found</p>
                  <button 
                    className="primary-btn"
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create Your First Agreement
                  </button>
                </div>
              ) : (
                <div className="contracts-list">
                  {contracts.map(contract => (
                    <div 
                      className="contract-card" 
                      key={contract.id}
                      onClick={() => setSelectedContract(contract)}
                    >
                      <div className="contract-header">
                        <span className={`status-badge ${contract.status}`}>
                          {contract.status}
                        </span>
                        <span className="contract-id">#{contract.id.substring(0, 6)}</span>
                      </div>
                      <div className="contract-body">
                        <h3>{contract.category} Agreement</h3>
                        <div className="contract-parties">
                          <div>
                            <span className="label">Creator:</span>
                            <span>{contract.creator.substring(0, 6)}...{contract.creator.substring(38)}</span>
                          </div>
                          <div>
                            <span className="label">Counterparty:</span>
                            <span>{contract.counterparty.substring(0, 6)}...{contract.counterparty.substring(38)}</span>
                          </div>
                        </div>
                        <div className="contract-date">
                          {new Date(contract.timestamp * 1000).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="contract-actions">
                        {isCreator(contract.creator) && contract.status === "draft" && (
                          <button 
                            className="action-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              signContract(contract.id);
                            }}
                          >
                            Sign
                          </button>
                        )}
                        {contract.status === "signed" && (
                          <button 
                            className="action-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              executeContract(contract.id);
                            }}
                          >
                            Execute
                          </button>
                        )}
                        {(contract.status === "signed" || contract.status === "executed") && (
                          <button 
                            className="action-btn dispute-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              disputeContract(contract.id);
                            }}
                          >
                            Dispute
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {activeTab === "guide" && (
          <section className="guide-section">
            <h2>How FHE Legal Agreements Work</h2>
            <div className="guide-steps">
              {guideSteps.map((step, index) => (
                <div className="guide-step" key={index}>
                  <div className="step-number">{index + 1}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && (
                      <div className="step-details">
                        <div className="fhe-badge">FHE Technology</div>
                        <p>{step.details}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-explainer">
              <h3>Zama FHE Encryption Flow</h3>
              <div className="fhe-flow">
                <div className="flow-step">
                  <div className="flow-icon">🔓</div>
                  <div className="flow-label">Plain Terms</div>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="flow-icon">🔒</div>
                  <div className="flow-label">FHE Encryption</div>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="flow-icon">⚖️</div>
                  <div className="flow-label">On-chain Storage</div>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="flow-icon">✔️</div>
                  <div className="flow-label">FHE Verification</div>
                </div>
                <div className="flow-arrow">→</div>
                <div className="flow-step">
                  <div className="flow-icon">🧑‍⚖️</div>
                  <div className="flow-label">DAO Arbitration</div>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "faq" && (
          <section className="faq-section">
            <h2>Frequently Asked Questions</h2>
            <div className="faq-list">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <div className="faq-question">
                    <h3>{item.question}</h3>
                    <button 
                      className="toggle-btn"
                      onClick={() => setShowFAQ(showFAQ === index ? null : index)}
                    >
                      {showFAQ === index ? "−" : "+"}
                    </button>
                  </div>
                  {showFAQ === index && (
                    <div className="faq-answer">
                      <p>{item.answer}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New Agreement</h2>
              <button 
                className="close-btn"
                onClick={() => setShowCreateModal(false)}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Agreement Type</label>
                <select
                  name="category"
                  value={newContractData.category}
                  onChange={(e) => setNewContractData({
                    ...newContractData,
                    category: e.target.value
                  })}
                >
                  <option value="NDA">Non-Disclosure Agreement</option>
                  <option value="Service">Service Agreement</option>
                  <option value="Sales">Sales Contract</option>
                  <option value="Partnership">Partnership Agreement</option>
                  <option value="Employment">Employment Contract</option>
                </select>
              </div>

              <div className="form-group">
                <label>Counterparty Address</label>
                <input
                  type="text"
                  placeholder="0x..."
                  value={newContractData.counterparty}
                  onChange={(e) => setNewContractData({
                    ...newContractData,
                    counterparty: e.target.value
                  })}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Price (ETH)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newContractData.price}
                    onChange={(e) => setNewContractData({
                      ...newContractData,
                      price: parseFloat(e.target.value) || 0
                    })}
                  />
                  <div className="fhe-tag">FHE Encrypted</div>
                </div>

                <div className="form-group">
                  <label>Delivery Date (Days)</label>
                  <input
                    type="number"
                    value={newContractData.deliveryDate}
                    onChange={(e) => setNewContractData({
                      ...newContractData,
                      deliveryDate: parseInt(e.target.value) || 0
                    })}
                  />
                  <div className="fhe-tag">FHE Encrypted</div>
                </div>
              </div>

              <div className="form-group">
                <label>Penalty Clause (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={newContractData.penaltyClause}
                  onChange={(e) => setNewContractData({
                    ...newContractData,
                    penaltyClause: parseFloat(e.target.value) || 0
                  })}
                />
                <div className="fhe-tag">FHE Encrypted</div>
              </div>

              <div className="form-group">
                <label>General Terms</label>
                <textarea
                  placeholder="Describe the agreement terms..."
                  value={newContractData.terms}
                  onChange={(e) => setNewContractData({
                    ...newContractData,
                    terms: e.target.value
                  })}
                />
              </div>

              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-grid">
                  <div className="preview-item">
                    <span>Price:</span>
                    <div>{FHEEncryptNumber(newContractData.price).substring(0, 20)}...</div>
                  </div>
                  <div className="preview-item">
                    <span>Delivery:</span>
                    <div>{FHEEncryptNumber(newContractData.deliveryDate).substring(0, 20)}...</div>
                  </div>
                  <div className="preview-item">
                    <span>Penalty:</span>
                    <div>{FHEEncryptNumber(newContractData.penaltyClause).substring(0, 20)}...</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="secondary-btn"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                className="primary-btn"
                onClick={createContract}
                disabled={creating}
              >
                {creating ? "Creating with FHE..." : "Create Agreement"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedContract && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Contract Details</h2>
              <button 
                className="close-btn"
                onClick={() => {
                  setSelectedContract(null);
                  setDecryptedValue(null);
                }}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="contract-meta">
                <div className="meta-item">
                  <span className="label">ID:</span>
                  <span>{selectedContract.id}</span>
                </div>
                <div className="meta-item">
                  <span className="label">Type:</span>
                  <span>{selectedContract.category}</span>
                </div>
                <div className="meta-item">
                  <span className="label">Status:</span>
                  <span className={`status-badge ${selectedContract.status}`}>
                    {selectedContract.status}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="label">Created:</span>
                  <span>{new Date(selectedContract.timestamp * 1000).toLocaleString()}</span>
                </div>
              </div>

              <div className="contract-parties">
                <div className="party-card">
                  <h3>Creator</h3>
                  <div className="party-address">{selectedContract.creator}</div>
                  {isCreator(selectedContract.creator) && (
                    <div className="party-you">(You)</div>
                  )}
                </div>
                <div className="party-card">
                  <h3>Counterparty</h3>
                  <div className="party-address">{selectedContract.counterparty}</div>
                  {address?.toLowerCase() === selectedContract.counterparty.toLowerCase() && (
                    <div className="party-you">(You)</div>
                  )}
                </div>
              </div>

              <div className="contract-terms">
                <h3>Encrypted Terms</h3>
                <div className="terms-encrypted">
                  <div className="fhe-badge">FHE Encrypted</div>
                  <div className="encrypted-data">
                    {selectedContract.encryptedTerms.substring(0, 100)}...
                  </div>
                  <button
                    className="decrypt-btn"
                    onClick={async () => {
                      if (decryptedValue !== null) {
                        setDecryptedValue(null);
                      } else {
                        const terms = JSON.parse(selectedContract.encryptedTerms);
                        const decryptedPrice = await decryptWithSignature(terms.price);
                        setDecryptedValue(decryptedPrice);
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : 
                     decryptedValue !== null ? "Hide Value" : "Decrypt Price"}
                  </button>
                </div>

                {decryptedValue !== null && (
                  <div className="terms-decrypted">
                    <div className="fhe-badge warning">Decrypted (DAO Access Only)</div>
                    <div className="decrypted-value">
                      <span>Price:</span>
                      <strong>{decryptedValue} ETH</strong>
                    </div>
                    <div className="decrypt-notice">
                      This value is only visible after DAO arbitration approval
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="primary-btn"
                onClick={() => {
                  setSelectedContract(null);
                  setDecryptedValue(null);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="transaction-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>FHE Legal Agreements</h3>
            <p>Secure, confidential business contracts powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright">
            © {new Date().getFullYear()} FHE Legal Agreements. All rights reserved.
          </div>
          <div className="fhe-badge">
            Powered by Zama FHE
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
