import { useState, useEffect, useRef } from 'react';
import './App.css';

interface OrderBookEntry {
  price: number;
  size: number;
  total: number;
}

// Removed synthetic generateOrderBook



const formatPrice = (value: number) => {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(value);
};


const SkewGraph = ({ telemetry }: { telemetry: any }) => {
  if (!telemetry || !telemetry.midPrice || telemetry.bid === 0) return (
    <div className="skew-graph-empty">Waiting for telemetry...</div>
  );
  
  const { midPrice, q, bids, asks } = telemetry;
  
  // Use furthest bid/ask to calculate spread view
  const furthestBid = bids && bids.length > 0 ? bids[bids.length - 1].price : telemetry.bid;
  const furthestAsk = asks && asks.length > 0 ? asks[asks.length - 1].price : telemetry.ask;
  const closestBid = bids && bids.length > 0 ? bids[0].price : telemetry.bid;
  const closestAsk = asks && asks.length > 0 ? asks[0].price : telemetry.ask;
  
  const spread = furthestAsk - furthestBid;
  const maxView = (spread / 2) * 1.5; // Expand view slightly past the furthest orders
  
  const getPos = (price: number) => {
    let p = ((price - (midPrice - maxView)) / (maxView * 2)) * 100;
    return Math.max(0, Math.min(100, p));
  };
  
  const midPos = getPos(midPrice);
  
  const skewPercentage = (q * 100).toFixed(1);
  const isVetoedBid = q > 0.4;
  const isVetoedAsk = q < -0.4;

  return (
    <div className="skew-graph-container" style={{ padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
      <div className="skew-graph-labels" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '12px', fontWeight: 'bold' }}>
        <span style={{color: '#10b981'}}>Bid: {closestBid.toFixed(2)} {isVetoedBid ? '(VETO)' : ''}</span>
        <span style={{color: '#888'}}>Mid: {midPrice.toFixed(2)}</span>
        <span style={{color: '#ef4444'}}>Ask: {closestAsk.toFixed(2)} {isVetoedAsk ? '(VETO)' : ''}</span>
      </div>
      <div className="skew-graph-track" style={{ position: 'relative', height: '24px', background: '#333', borderRadius: '4px', overflow: 'hidden' }}>
        <div className="skew-center-line" style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '2px', background: '#666', zIndex: 10 }}></div>
        <div className="skew-mid-dot" style={{ position: 'absolute', left: `${midPos}%`, top: '50%', transform: 'translate(-50%, -50%)', width: '8px', height: '8px', borderRadius: '50%', background: '#fff', zIndex: 11 }}></div>
        
        {!isVetoedBid && bids && bids.map((b: any, i: number) => {
           const bPos = getPos(b.price);
           return (
             <div key={`bid-${i}`} className="skew-bid-box" style={{ 
               position: 'absolute', left: `${bPos}%`, width: `${midPos - bPos}%`, height: '100%', 
               background: 'rgba(16, 185, 129, 0.25)', borderLeft: '1px solid rgba(16, 185, 129, 0.8)' 
             }}></div>
           )
        })}
        
        {!isVetoedAsk && asks && asks.map((a: any, i: number) => {
           const aPos = getPos(a.price);
           return (
             <div key={`ask-${i}`} className="skew-ask-box" style={{ 
               position: 'absolute', left: `${midPos}%`, width: `${aPos - midPos}%`, height: '100%', 
               background: 'rgba(239, 68, 68, 0.25)', borderRight: '1px solid rgba(239, 68, 68, 0.8)' 
             }}></div>
           )
        })}
      </div>
      <div className="skew-stats" style={{ marginTop: '10px', fontSize: '13px', textAlign: 'center', display: 'flex', justifyContent: 'space-around' }}>
        <span>Inventory Skew (q): <strong style={{color: Math.abs(q) > 0.3 ? '#ef4444' : '#10b981'}}>{skewPercentage}%</strong></span>
        <span>Order Levels: <strong style={{color: '#fff'}}>{bids?.length || 0}</strong></span>
      </div>
    </div>
  );
};
const InfoTooltip = ({ text }: { text: string }) => (
  <div className="info-tooltip">
    <span className="info-icon">?</span>
    <div className="tooltip-content">{text}</div>
  </div>
);

function App() {
  const [gamma, setGamma] = useState<number>(0.1);
  const [safetyMultiplier, setSafetyMultiplier] = useState<number>(5.0);

  const [maxInventorySkew, setMaxInventorySkew] = useState<number>(0.4);
  const [telemetry, setTelemetry] = useState<any>(null);
  const [lotMode, setLotMode] = useState<"PERCENTAGE" | "FIXED">("PERCENTAGE");
  const [lotValue, setLotValue] = useState<number>(0.05);
  
  const [isRunning, setIsRunning] = useState(false);
  const [orderbook, setOrderbook] = useState<{ asks: OrderBookEntry[], bids: OrderBookEntry[] }>({ asks: [], bids: [] });

  const [latency, setLatency] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [simBalance, setSimBalance] = useState<number>(1000);
  const [isEditingSimBalance, setIsEditingSimBalance] = useState(false);
  const [simBalanceInput, setSimBalanceInput] = useState("");
  const [bnbBalance, setBnbBalance] = useState<number | null>(null);
  const [simBnbBalance, setSimBnbBalance] = useState<number>(1.0);
  const [isEditingSimBnbBalance, setIsEditingSimBnbBalance] = useState(false);
  const [simBnbBalanceInput, setSimBnbBalanceInput] = useState("");
  
  const [tradingMode, setTradingMode] = useState<"BACKTEST" | "LIVE">("BACKTEST");
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [backtestStart, setBacktestStart] = useState<string>(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 16));
  const [backtestEnd, setBacktestEnd] = useState<string>(new Date().toISOString().slice(0, 16));
  const [backtestStatus, setBacktestStatus] = useState<"IDLE" | "DOWNLOADING" | "RUNNING" | "COMPLETED" | "ERROR">("IDLE");
  const [backtestProgress, setBacktestProgress] = useState<number>(0);
  const [backtestResults, setBacktestResults] = useState<any>(null);
  const [backtestError, setBacktestError] = useState<string>("");
  const [liveConfirmInput, setLiveConfirmInput] = useState("");
  const [bnbDiscount, setBnbDiscount] = useState(false);
  const [activePair, setActivePair] = useState<string>("btcbrl");
  const [debouncedPair, setDebouncedPair] = useState<string>("btcbrl");
  const [systemErrors, setSystemErrors] = useState<string[]>([]);
  const [bnbDiscountLocked, setBnbDiscountLocked] = useState(false);
  const [maxDrawdownPct, setMaxDrawdownPct] = useState<number>(0.02);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedPair(activePair), 1500);
    return () => clearTimeout(timer);
  }, [activePair]);


  const wsRef = useRef<WebSocket | null>(null);
  const bnbDiscountRef = useRef(bnbDiscount);
  const lastBnbToggleTime = useRef<number>(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;

    const connect = () => {
      if (!isMounted) return;
      const apiUrl = import.meta.env.VITE_API_URL || 'ws://localhost:3000';
      ws = new WebSocket(apiUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'UPDATE') {

            if (data.latency) setLatency(data.latency);
            if (data.balance !== undefined) setBalance(data.balance);
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.bestPair !== undefined) setActivePair(data.bestPair);
            if (data.isRunning !== undefined) setIsRunning(data.isRunning);
            if (data.errors !== undefined) setSystemErrors(data.errors);
            if (data.balance !== undefined) setBalance(data.balance);
            if (data.bnbBalance !== undefined) setBnbBalance(data.bnbBalance);
            if (data.gamma !== undefined) setGamma(data.gamma);
            if (data.safetyMultiplier !== undefined) setSafetyMultiplier(data.safetyMultiplier);

            if (data.maxInventorySkew !== undefined) setMaxInventorySkew(data.maxInventorySkew);
            if (data.maxDrawdownPct !== undefined) setMaxDrawdownPct(data.maxDrawdownPct);
            if (data.bnbDiscountLocked !== undefined) setBnbDiscountLocked(data.bnbDiscountLocked);
                    } else if (data.type === 'TELEMETRY') {
            setTelemetry(data);
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.gamma !== undefined) setGamma(data.gamma);
            if (data.safetyMultiplier !== undefined) setSafetyMultiplier(data.safetyMultiplier);

            if (data.maxInventorySkew !== undefined) setMaxInventorySkew(data.maxInventorySkew);
            if (data.lotMode !== undefined) setLotMode(data.lotMode);
            if (data.lotValue !== undefined) setLotValue(data.lotValue);
            if (data.quoteBalance !== undefined) setBalance(data.quoteBalance);
            if (data.bnbBalance !== undefined) setBnbBalance(data.bnbBalance);
            if (data.latency !== undefined) setLatency(data.latency);
            if (data.bnbDiscount !== undefined && Date.now() - lastBnbToggleTime.current > 1500) {
              setBnbDiscount(data.bnbDiscount);
              bnbDiscountRef.current = data.bnbDiscount;
            }
          } else if (data.type === 'STATUS') {
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.quoteBalance !== undefined) setBalance(data.quoteBalance);
            if (data.bnbBalance !== undefined) setBnbBalance(data.bnbBalance);
            if (data.isRunning !== undefined) setIsRunning(data.isRunning);
            if (data.bnbDiscount !== undefined && Date.now() - lastBnbToggleTime.current > 1500) {
              setBnbDiscount(data.bnbDiscount);
              bnbDiscountRef.current = data.bnbDiscount;
            }
            if (data.bnbDiscountLocked !== undefined) setBnbDiscountLocked(data.bnbDiscountLocked);
          } else if (data.type === 'BACKTEST_STATUS') {
            setBacktestStatus(data.status);
            if (data.status === 'ERROR') setBacktestError(data.message);
            if (data.status === 'COMPLETED') setBacktestResults(data);
          } else if (data.type === 'BACKTEST_PROGRESS') {
            setBacktestProgress(data.progress);
            setBalance(data.quoteBalance);
            setTelemetry((prev: any) => ({ ...prev, baseBalance: data.baseBalance, quoteBalance: data.quoteBalance }));
          }
        } catch (e) {
          console.error("Invalid WS message");
        }
      };

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: "GET_STATUS" }));
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (isMounted) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    let binanceWs: WebSocket;
    if (isRunning) {
      let binanceWsUrl = import.meta.env.VITE_BINANCE_WS_URL;
      if (binanceWsUrl) {
          binanceWsUrl = binanceWsUrl.replace(/\/ws\/[^@]+@/, `/ws/${debouncedPair}@`);
      } else {
          binanceWsUrl = `wss://stream.binance.com:9443/ws/${debouncedPair}@depth20@100ms`;
      }
      binanceWs = new WebSocket(binanceWsUrl);
      binanceWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.asks && data.bids) {
            const processLevels = (levels: string[][], isAsk: boolean): OrderBookEntry[] => {
              let total = 0;
              const parsed = levels.slice(0, 15).map(level => {
                const price = parseFloat(level[0]);
                const size = parseFloat(level[1]);
                total += size;
                return { price, size: Number(size.toFixed(4)), total: Number(total.toFixed(4)) };
              });
              return isAsk ? parsed.reverse() : parsed;
            };
            
            setOrderbook({
              asks: processLevels(data.asks, true),
              bids: processLevels(data.bids, false)
            });
          }
        } catch(e) {}
      };
    }

    return () => {
      if (binanceWs) binanceWs.close();
    };
  }, [isRunning, debouncedPair]);

  const maxTotal = Math.max(
    orderbook.asks[0]?.total || 1,
    orderbook.bids[orderbook.bids.length - 1]?.total || 1
  );

  const currentTotalWealth = (balance ?? 0) + ((telemetry?.baseBalance ?? 0) * (telemetry?.midPrice ?? 0));
  const minLotAmount = telemetry?.minNotional ?? 10;
  const minLotPct = currentTotalWealth > 0 ? Math.ceil((minLotAmount / currentTotalWealth) * 1000) / 1000 : 0.01;
  const maxLotPct = 0.60;
  const maxLotAmount = currentTotalWealth * maxLotPct;

  const handleToggleMode = (mode: "BACKTEST" | "LIVE") => {
    if (mode === "LIVE" && tradingMode === "BACKTEST") {
      setShowLiveModal(true);
      setLiveConfirmInput("");
    } else if (mode === "BACKTEST" && tradingMode === "LIVE") {
      setTradingMode("BACKTEST");
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "TOGGLE_MODE", mode: "BACKTEST", simBalance }));
      }
    }
  };

  const confirmLiveMode = () => {
    if (liveConfirmInput === "CONFIRMAR") {
      setTradingMode("LIVE");
      setShowLiveModal(false);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "TOGGLE_MODE", mode: "LIVE" }));
      }
    }
  };

  const handleSimBalanceSubmit = () => {
    const val = parseFloat(simBalanceInput);
    if (!isNaN(val) && val > 0) {
      setSimBalance(val);
      setIsEditingSimBalance(false);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "SET_SIM_BALANCE", quoteBalance: val }));
      }
    }
  };

  const handleSimBnbBalanceSubmit = () => {
    const val = parseFloat(simBnbBalanceInput);
    if (!isNaN(val)) {
      setSimBnbBalance(val);
      setBnbBalance(val);
      setIsEditingSimBnbBalance(false);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "SET_SIM_BNB_BALANCE", bnbBalance: val }));
      }
    }
  };


  return (
    <div className={`app-container ${tradingMode === 'LIVE' ? 'live-mode' : ''}`}>
      {showLiveModal && (
        <div className="confirmation-modal-overlay">
          <div className="confirmation-modal-content">
            <h2>Ativar Modo LIVE</h2>
            <p>Você está prestes a ativar o modo de trading real. Ordens reais serão executadas com dinheiro da sua conta Binance.</p>
            <input 
              type="text" 
              placeholder="Digite CONFIRMAR para ativar" 
              value={liveConfirmInput}
              onChange={(e) => setLiveConfirmInput(e.target.value)}
            />
            <div className="modal-buttons">
              <button className="btn btn-ghost" onClick={() => setShowLiveModal(false)}>Cancelar</button>
              <button 
                className="btn btn-danger" 
                disabled={liveConfirmInput !== "CONFIRMAR"}
                onClick={confirmLiveMode}
              >
                Ativar LIVE
              </button>
            </div>
          </div>
        </div>
      )}

      {telemetry?.killSwitchEngaged && (
        <div className="kill-switch-overlay" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(239, 68, 68, 0.9)', zIndex: 9999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          color: 'white', textShadow: '0 2px 10px rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)'
        }}>
          <h1 style={{ fontSize: '4rem', margin: '0 0 20px 0', fontWeight: '900' }}>SYSTEM HALTED</h1>
          <h2 style={{ fontSize: '2rem', margin: 0 }}>GLOBAL STOP-LOSS ENGAGED</h2>
          <p style={{ marginTop: '20px', fontSize: '1.2rem', maxWidth: '600px', textAlign: 'center' }}>
            O limite máximo de perda (Drawdown) foi atingido. Todas as ordens foram canceladas e o motor foi desligado para proteger o capital remanescente.
          </p>
        </div>
      )}

      <header className="header">
        <div className="header-title">
          <h1>Nexus HFT Engine</h1>
          <div className={`status-badge ${isRunning ? 'online' : 'offline'}`}>
            <div className="status-dot"></div>
            {isRunning ? 'System Active' : 'System Halted'}
          </div>
          <div className={`mode-badge ${tradingMode.toLowerCase()}`}>
            {tradingMode === 'BACKTEST' ? 'BACKTESTING' : 'LIVE TRADING'}
          </div>
        </div>
        <div className="controls">
          <div className="mode-toggle">
            <div 
              className={`mode-toggle-option ${tradingMode === 'BACKTEST' ? 'active sim' : ''}`}
              onClick={() => handleToggleMode("BACKTEST")}
            >
              BACKTEST
            </div>
            <div 
              className={`mode-toggle-option ${tradingMode === 'LIVE' ? 'active live' : ''}`}
              onClick={() => handleToggleMode("LIVE")}
            >
              LIVE
            </div>
          </div>

          {!isRunning ? (
            <button className="btn btn-start" onClick={() => {
              setIsRunning(true);
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "TOGGLE_ENGINE", running: true }));
              }
            }}>
              INITIATE ENGINE
            </button>
          ) : (
            <button className="btn btn-stop" onClick={() => {
              setIsRunning(false);
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "TOGGLE_ENGINE", running: false }));
              }
            }}>
              HALT TRADING
            </button>
          )}
        </div>
      </header>

      {tradingMode === 'BACKTEST' && (
        <div className="glass-panel" style={{ margin: '15px 0', padding: '15px' }}>
          <div className="panel-title" style={{ color: '#3b82f6', marginBottom: '15px' }}>Backtest Configuration</div>
          <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px' }}>
              Start Time: 
              <input type="datetime-local" value={backtestStart} onChange={e => setBacktestStart(e.target.value)} style={{ padding: '8px', borderRadius: '4px', border: '1px solid #444', background: '#222', color: '#fff' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px' }}>
              End Time:
              <input type="datetime-local" value={backtestEnd} onChange={e => setBacktestEnd(e.target.value)} style={{ padding: '8px', borderRadius: '4px', border: '1px solid #444', background: '#222', color: '#fff' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px' }}>
              Initial Balance ($):
              <input type="number" value={simBalance} onChange={e => setSimBalance(Number(e.target.value))} style={{ padding: '8px', borderRadius: '4px', border: '1px solid #444', background: '#222', color: '#fff' }} />
            </label>
            <button 
              className="btn btn-start"
              style={{ marginTop: '16px' }}
              disabled={backtestStatus === "DOWNLOADING" || backtestStatus === "RUNNING"}
              onClick={() => {
                 const s = new Date(backtestStart).getTime();
                 const e = new Date(backtestEnd).getTime();
                 if (e <= s) {
                    alert("End time must be after start time"); return;
                 }
                 if (e - s > 31 * 24 * 60 * 60 * 1000) {
                    alert("Max period is 1 month"); return;
                 }
                 setBacktestStatus("IDLE");
                 setBacktestResults(null);
                 wsRef.current?.send(JSON.stringify({ type: "RUN_BACKTEST", startTime: s, endTime: e, initialBalance: simBalance }));
              }}
            >
              Run Backtest
            </button>
          </div>
          
          {backtestStatus !== "IDLE" && (
            <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', borderLeft: '4px solid #3b82f6' }}>
              <h3 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#94a3b8' }}>Status: <span style={{ color: '#fff' }}>{backtestStatus}</span></h3>
              {backtestStatus === "DOWNLOADING" && <p style={{ fontSize: '13px', color: '#eab308' }}>Downloading historical data from Binance... This may take a moment.</p>}
              {backtestStatus === "ERROR" && <p style={{ fontSize: '13px', color: '#ef4444' }}>Error: {backtestError}</p>}
              {backtestStatus === "RUNNING" && (
                <div style={{ marginTop: '10px' }}>
                   <div style={{ width: '100%', background: '#333', height: '12px', borderRadius: '6px', overflow: 'hidden' }}>
                     <div style={{ width: `${backtestProgress}%`, background: '#3b82f6', height: '100%', transition: 'width 0.2s' }}></div>
                   </div>
                   <p style={{ marginTop: '5px', fontSize: '12px', textAlign: 'right' }}>{backtestProgress.toFixed(1)}%</p>
                </div>
              )}
              {backtestStatus === "COMPLETED" && backtestResults && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '15px', marginTop: '15px' }}>
                  <div style={{ background: '#222', padding: '10px', borderRadius: '6px' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '5px' }}>Initial Balance</div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold' }}>${simBalance.toFixed(2)}</div>
                  </div>
                  <div style={{ background: '#222', padding: '10px', borderRadius: '6px' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '5px' }}>Final Balance (Quote)</div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: backtestResults.finalQuote >= simBalance ? '#10b981' : '#ef4444' }}>${backtestResults.finalQuote.toFixed(2)}</div>
                  </div>
                  <div style={{ background: '#222', padding: '10px', borderRadius: '6px' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '5px' }}>Total Fees Paid</div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#eab308' }}>${backtestResults.totalFees.toFixed(2)}</div>
                  </div>
                  <div style={{ background: '#222', padding: '10px', borderRadius: '6px' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '5px' }}>Net PnL</div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: backtestResults.finalQuote >= simBalance ? '#10b981' : '#ef4444' }}>
                      ${(backtestResults.finalQuote - simBalance).toFixed(2)} ({( ((backtestResults.finalQuote - simBalance) / simBalance) * 100 ).toFixed(2)}%)
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      
      <div className="mm-controls-panel glass-panel" style={{ margin: '8px 0', padding: '12px' }}>
        <div className="panel-title" style={{ marginBottom: '8px' }}>Market Making Telemetry & Tuning</div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', alignItems: 'center' }}>
          <div>
            <div className="control-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  Gamma (Risk Aversion):
                  <InfoTooltip text="Contribui, de forma limitada, para o spread cotado (termo de Avellaneda-Stoikov). Não desloca mais o preço de reserva — o controle real de estoque hoje é por TAMANHO de ordem (veja Effective Buy/Sell Lot abaixo): quanto mais comprado, menor o lote de compra e maior o de venda." />
                </span>
                <strong>{gamma}</strong>
              </label>
              <input type="range" min="0" max="1" step="0.05" value={gamma} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setGamma(val);
                wsRef.current?.send(JSON.stringify({ type: "UPDATE_MM_PARAMS", gamma: val }));
              }} style={{ width: '100%', accentColor: '#3b82f6' }} />
            </div>
            
            <div className="control-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  Safety Multiplier (Spread):
                  <InfoTooltip text="Multiplica a volatilidade para definir a distância (spread) da sua ordem. Menor = ordens mais frequentes. Maior = mais proteção." />
                </span>
                <strong>{safetyMultiplier.toFixed(1)}x</strong>
              </label>
              <input type="range" min="1.0" max="10.0" step="0.5" value={safetyMultiplier} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setSafetyMultiplier(val);
                wsRef.current?.send(JSON.stringify({ type: "UPDATE_MM_PARAMS", safetyMultiplier: val }));
              }} style={{ width: '100%', accentColor: '#3b82f6' }} />
            </div>

            <div className="control-group">
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  Max Inventory Skew:
                  <InfoTooltip text="Porcentagem máxima de desbalanceamento de estoque aceitável (ex: 40% significa máximo 90% Base e 10% Quote). Se atingir esse limite, o bot para de comprar/vender na ponta em risco." />
                </span>
                <strong>{(maxInventorySkew * 100).toFixed(0)}%</strong>
              </label>
              <input type="range" min="0.1" max="0.9" step="0.05" value={maxInventorySkew} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setMaxInventorySkew(val);
                wsRef.current?.send(JSON.stringify({ type: "UPDATE_MM_PARAMS", maxInventorySkew: val }));
              }} style={{ width: '100%', accentColor: '#3b82f6' }} />
            </div>

            <div className="control-group">
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  Order Lot Size:
                  <InfoTooltip text="Define se o tamanho de cada ordem enviada será um Valor Fixo (ex: 50 USD) ou uma Porcentagem do Capital Livre (ex: 5% da carteira). A parte dinâmica acelera as vendas se acumular estoque excessivo." />
                </span>
                <div>
                  <button 
                    onClick={() => {
                      const newMode = lotMode === 'PERCENTAGE' ? 'FIXED' : 'PERCENTAGE';
                      let newValue = newMode === 'PERCENTAGE' ? Math.max(minLotPct, Math.min(maxLotPct, lotValue)) : Math.max(minLotAmount, Math.min(maxLotAmount, lotValue));
                      if (newMode === 'PERCENTAGE' && newValue < minLotPct) newValue = minLotPct;
                      else if (newMode === 'FIXED' && newValue < minLotAmount) newValue = minLotAmount;
                      setLotMode(newMode);
                      setLotValue(newValue);
                      wsRef.current?.send(JSON.stringify({ type: "UPDATE_LOT_CONFIG", mode: newMode, value: newValue }));
                    }}
                    style={{ background: 'transparent', border: '1px solid #3b82f6', color: '#3b82f6', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', marginRight: '8px' }}
                  >
                    Mode: {lotMode === 'PERCENTAGE' ? '% of Balance' : 'Fixed Amount'}
                  </button>
                  <strong>{lotMode === 'PERCENTAGE' ? `${(lotValue * 100).toFixed(1)}%` : `$${lotValue.toFixed(2)}`}</strong>
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '4px', textAlign: 'right' }}>
                    Min: {lotMode === 'PERCENTAGE' ? `${(minLotPct * 100).toFixed(1)}% ($${minLotAmount})` : `$${minLotAmount.toFixed(2)}`} | Max: {lotMode === 'PERCENTAGE' ? `${(maxLotPct * 100).toFixed(1)}%` : `$${maxLotAmount.toFixed(2)}`}
                  </div>
                </div>
              </label>
              <input type="range" 
                min={lotMode === 'PERCENTAGE' ? minLotPct : minLotAmount} 
                max={lotMode === 'PERCENTAGE' ? maxLotPct : maxLotAmount} 
                step={lotMode === 'PERCENTAGE' ? 0.005 : 5} 
                value={lotValue} 
                onChange={(e) => {
                  let val = parseFloat(e.target.value);
                  const minBound = lotMode === 'PERCENTAGE' ? minLotPct : minLotAmount;
                  const maxBound = lotMode === 'PERCENTAGE' ? maxLotPct : maxLotAmount;
                  val = Math.max(minBound, Math.min(maxBound, val));
                  setLotValue(val);
                  wsRef.current?.send(JSON.stringify({ type: "UPDATE_LOT_CONFIG", value: val }));
                }} style={{ width: '100%', accentColor: '#3b82f6' }} />
                
                <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', textAlign: 'center' }}>
                  <div>
                    <div style={{ color: '#10b981', marginBottom: '2px' }}>Effective Buy Lot</div>
                    <div style={{ color: '#10b981', fontWeight: 'bold' }}>{telemetry?.effectiveBuyLot !== undefined ? `$${telemetry.effectiveBuyLot.toFixed(2)}` : '--'}</div>
                  </div>
                  <div>
                    <div style={{ color: '#ef4444', marginBottom: '2px' }}>Effective Sell Lot</div>
                    <div style={{ color: '#ef4444', fontWeight: 'bold' }}>{telemetry?.effectiveSellLot !== undefined ? `$${telemetry.effectiveSellLot.toFixed(2)}` : '--'}</div>
                  </div>
                </div>
            </div>

            <div className="control-group" style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ display: 'flex', alignItems: 'center' }}>
                  Max Drawdown (Kill Switch):
                  <InfoTooltip text="Se a carteira cair mais que essa porcentagem em relação à máxima histórica, o robô corta as operações e cancela tudo." />
                </span>
                <strong style={{ color: '#ef4444' }}>{(maxDrawdownPct * 100).toFixed(1)}%</strong>
              </label>
              <input type="range" min="0.01" max="0.10" step="0.01" value={maxDrawdownPct} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setMaxDrawdownPct(val);
                wsRef.current?.send(JSON.stringify({ type: "UPDATE_RISK_PARAMS", maxDrawdownPct: val }));
              }} style={{ width: '100%', accentColor: '#ef4444' }} />
            </div>

          </div>
          
          <div className="telemetry-graph-wrapper">
             <SkewGraph telemetry={telemetry} />
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="glass-panel orderbook-panel">
          <div className="panel-title">Live Orderbook ({debouncedPair.toUpperCase().replace('BRL', '/BRL').replace('USDT', '/USDT').replace('FDUSD', '/FDUSD')})</div>
          <div className="orderbook-container">
            <table className="orderbook-table">
              <thead>
                <tr>
                  <th>Price</th>
                  <th>Size</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {orderbook.asks.map((ask, idx) => (
                  <tr key={`ask-${idx}`}>
                    <td className="price-ask">{formatPrice(ask.price)}</td>
                    <td>{ask.size}</td>
                    <td>
                      {ask.total}
                      <div 
                        className="size-bar ask" 
                        style={{ width: `${(ask.total / maxTotal) * 100}%` }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            
            <div className="orderbook-spread">
              Spread: {formatPrice((orderbook.asks[orderbook.asks.length - 1]?.price || 0) - (orderbook.bids[0]?.price || 0))}
            </div>

            <table className="orderbook-table">
              <tbody>
                {orderbook.bids.map((bid, idx) => (
                  <tr key={`bid-${idx}`}>
                    <td className="price-bid">{formatPrice(bid.price)}</td>
                    <td>{bid.size}</td>
                    <td>
                      {bid.total}
                      <div 
                        className="size-bar bid" 
                        style={{ width: `${(bid.total / maxTotal) * 100}%` }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="metrics-row">
          <div className="glass-panel metric-card">
            <div className="panel-title">Inventory Skew (q)</div>
            <div className={`metric-value ${telemetry?.q !== undefined && Math.abs(telemetry.q) > 0.3 ? 'negative' : 'positive'}`}>
              {telemetry?.q !== undefined ? `${(telemetry.q * 100).toFixed(1)}%` : '--%'}
            </div>
          </div>
          <div className="glass-panel metric-card">
            <div className="panel-title">
              {tradingMode === 'BACKTEST' ? `Base Inventory (Sim ${telemetry?.baseSymbol || ''})` : `Base Inventory (Live ${telemetry?.baseSymbol || ''})`}
            </div>
            <div className={`metric-value ${tradingMode === 'BACKTEST' ? 'simulated' : 'positive'}`}>
              {telemetry?.baseBalance !== undefined ? `${telemetry.baseBalance.toFixed(4)} ${telemetry.baseSymbol || ''}` : '--'}
            </div>
          </div>
          <div className="glass-panel metric-card">
            <div className="panel-title">
              {tradingMode === 'BACKTEST' ? `Quote Balance (Sim ${telemetry?.quoteSymbol || ''})` : `Quote Balance (Live ${telemetry?.quoteSymbol || ''})`}
              {tradingMode === 'BACKTEST' && (
                <span className="edit-sim-balance" onClick={() => {
                  setIsEditingSimBalance(!isEditingSimBalance);
                  if (!isEditingSimBalance) setSimBalanceInput(balance?.toString() || simBalance.toString());
                }}>
                  ✎
                </span>
              )}
            </div>
            <div className={`metric-value ${tradingMode === 'BACKTEST' ? 'simulated' : 'positive'}`}>
              {tradingMode === 'BACKTEST' && isEditingSimBalance ? (
                <div className="sim-balance-edit-container">
                  <input 
                    type="number" 
                    className="sim-balance-edit"
                    value={simBalanceInput} 
                    onChange={e => setSimBalanceInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSimBalanceSubmit()}
                    autoFocus
                  />
                  <span className="sim-balance-confirm" onClick={handleSimBalanceSubmit}>✓</span>
                </div>
              ) : (
                balance !== null ? `${balance.toFixed(2)}` : '--'
              )}
            </div>
          </div>

          <div className="glass-panel metric-card">
            <div className="panel-title">Network Latency (NY4)</div>
            <div className="metric-value" style={{ color: latency !== null && latency < 10 ? 'var(--color-up)' : '#eab308' }}>
              {latency !== null ? `${latency}ms` : '--ms'}
            </div>
          </div>
          <div className="glass-panel metric-card">
            <div className="panel-title">Top of Book Distance</div>
            <div className="metric-value" style={{ fontSize: '13px', lineHeight: '1.6' }}>
              {telemetry?.bidDistancePct !== undefined ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ color: telemetry.bidDistancePct < 0.01 ? 'var(--color-up)' : telemetry.bidDistancePct < 0.05 ? '#eab308' : '#ef4444' }}>
                    Bid: {telemetry.bidDistancePct < 0.001 ? 'TOP' : `-${telemetry.bidDistancePct.toFixed(4)}%`}
                    {telemetry.bidDistanceAbs !== undefined && telemetry.bidDistanceAbs > 0 ? ` ($${telemetry.bidDistanceAbs.toFixed(2)})` : ''}
                  </span>
                  <span style={{ color: telemetry.askDistancePct < 0.01 ? 'var(--color-up)' : telemetry.askDistancePct < 0.05 ? '#eab308' : '#ef4444' }}>
                    Ask: {telemetry.askDistancePct < 0.001 ? 'TOP' : `+${telemetry.askDistancePct.toFixed(4)}%`}
                    {telemetry.askDistanceAbs !== undefined && telemetry.askDistanceAbs > 0 ? ` ($${telemetry.askDistanceAbs.toFixed(2)})` : ''}
                  </span>
                </div>
              ) : '--'}
            </div>
          </div>
          <div className="glass-panel metric-card">
            <div className="panel-title">Adaptive Spread (Auto)</div>
            <div className="metric-value" style={{ fontSize: '12px', lineHeight: '1.7' }}>
              {telemetry?.effectiveSpread !== undefined ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                  <span style={{ color: '#94a3b8' }}>
                    Vol (30s): {telemetry.volatilityPct !== undefined ? `${(telemetry.volatilityPct * 100).toFixed(4)}%` : '--'}
                    {telemetry.safetyMultiplier !== undefined ? ` × ${telemetry.safetyMultiplier}σ` : ''}
                  </span>
                  <span style={{ color: '#3b82f6', fontWeight: 'bold', fontSize: '14px' }}>
                    Spread: {(telemetry.effectiveSpread * 100).toFixed(4)}%
                  </span>
                  <span style={{ color: '#94a3b8' }}>
                    ≈ ${telemetry.midPrice ? (telemetry.midPrice * telemetry.effectiveSpread).toFixed(2) : '--'} total
                  </span>
                </div>
              ) : '--'}
            </div>
          </div>
          <div className="glass-panel metric-card">
            <div className="panel-title" style={{ display: 'flex', alignItems: 'center' }}>
              Maker Fee (Live)
              <InfoTooltip text="Taxa maker lida direto da Binance (não de uma lista fixa por par), revalidada de hora em hora. Se subir, o piso de spread por taxa (2× a taxa × 1.5) sobe junto — fique atento se este valor deixar de ser 0%." />
            </div>
            <div className="metric-value" style={{ fontSize: '16px' }}>
               {telemetry?.feeRate !== undefined ? (
                 <div style={{ display: 'flex', flexDirection: 'column' }}>
                   <span style={{ fontWeight: 'bold', color: telemetry.feeRate === 0 ? 'var(--color-up)' : '#eab308' }}>
                     {(telemetry.feeRate * 100).toFixed(4)}%
                   </span>
                   <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                     round-trip: {(telemetry.feeRate * 2 * 100).toFixed(4)}%
                   </span>
                 </div>
               ) : '--'}
            </div>
          </div>

          <div className="glass-panel metric-card">
            <div className="panel-title">Total Wealth (Est. {telemetry?.quoteSymbol || 'Quote'})</div>
            <div className="metric-value" style={{ color: '#3b82f6' }}>
               {(balance !== null && telemetry?.midPrice !== undefined && telemetry?.baseBalance !== undefined) 
                 ? `${telemetry.quoteSymbol === 'USDT' || telemetry.quoteSymbol === 'FDUSD' ? '$' : 'R$'} ${((telemetry.baseBalance * telemetry.midPrice) + balance).toFixed(2)}` 
                 : '--'}
            </div>
          </div>
          
          <div className="glass-panel metric-card">
            <div className="panel-title">Market Intensity ($k$)</div>
            <div className="metric-value" style={{ fontSize: '14px', lineHeight: '1.4' }}>
               {telemetry?.intensityK !== undefined ? (
                 <div style={{ display: 'flex', flexDirection: 'column' }}>
                   <span style={{ fontSize: '20px', fontWeight: 'bold', color: telemetry.intensityK > 2.0 ? '#ef4444' : telemetry.intensityK > 1.2 ? '#eab308' : '#10b981' }}>
                     {telemetry.intensityK.toFixed(2)}
                   </span>
                   <span style={{ color: '#94a3b8', fontSize: '12px' }}>
                     {telemetry.intensityK > 2.0 ? 'High Frenzy' : telemetry.intensityK > 1.2 ? 'Active' : 'Calm'}
                   </span>
                 </div>
               ) : '--'}
            </div>
          </div>
          
          <div className="glass-panel metric-card" style={{ borderRight: (telemetry?.hangingOrdersCount ?? 0) > 0 ? '4px solid #f59e0b' : 'none' }}>
            <div className="panel-title" style={{ display: 'flex', alignItems: 'center' }}>
              Hanging Orders
              <InfoTooltip text="Ordens que ficaram fora do ciclo normal de cotação. O mecanismo de ping-pong (que gerava uma ordem oposta automática a cada fill) foi removido; hoje só existem se algo externo deixar uma ordem presa, e são expiradas por idade (10min) ou distância do preço (1%). Em operação normal deve ficar em 0." />
            </div>
            <div className="metric-value" style={{ fontSize: '14px', lineHeight: '1.4' }}>
               {telemetry?.hangingOrdersCount !== undefined ? (
                 <div style={{ display: 'flex', flexDirection: 'column' }}>
                   <span style={{ fontSize: '20px', fontWeight: 'bold', color: (telemetry.hangingOrdersCount ?? 0) > 0 ? '#f59e0b' : '#94a3b8' }}>
                     {telemetry.hangingOrdersCount} Orders
                   </span>
                   <span style={{ color: '#94a3b8', fontSize: '12px' }}>
                     {telemetry.hangingOrdersValue > 0 ? `$${telemetry.hangingOrdersValue.toFixed(2)} Total` : 'None (expected)'}
                   </span>
                 </div>
               ) : '--'}
            </div>
          </div>

          <div className="glass-panel metric-card">
            <div className="panel-title" style={{ display: 'flex', alignItems: 'center' }}>
              Active Memory Orders
              <InfoTooltip text="Após um fill, o lado correspondente fica em cooldown (filled_order_delay) antes de recotar — é intencional, não um travamento. Um lado sem ordem aberta e sem cooldown ativo pode indicar saldo insuficiente ou o lado desabilitado pelo Max Inventory Skew." />
            </div>
            <div className="metric-value" style={{ fontSize: '12px', lineHeight: '1.6' }}>
               {telemetry?.activeBuyCount !== undefined ? (
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                   <div style={{ display: 'flex', justifyContent: 'space-between', color: '#10b981' }}>
                     <span>{telemetry.activeBuyCount} Buys Open</span>
                     <strong>${telemetry.activeBuyValue?.toFixed(2)}</strong>
                   </div>
                   <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ef4444' }}>
                     <span>{telemetry.activeSellCount} Sells Open</span>
                     <strong>${telemetry.activeSellValue?.toFixed(2)}</strong>
                   </div>
                   {((telemetry.buyCooldownMs ?? 0) > 0 || (telemetry.sellCooldownMs ?? 0) > 0) && (
                     <div style={{ marginTop: '2px', paddingTop: '4px', borderTop: '1px solid rgba(255,255,255,0.1)', color: '#f59e0b', fontSize: '11px' }}>
                       {(telemetry.buyCooldownMs ?? 0) > 0 && <div>⏳ Buy cooldown: {Math.ceil(telemetry.buyCooldownMs / 1000)}s</div>}
                       {(telemetry.sellCooldownMs ?? 0) > 0 && <div>⏳ Sell cooldown: {Math.ceil(telemetry.sellCooldownMs / 1000)}s</div>}
                     </div>
                   )}
                 </div>
               ) : '--'}
            </div>
          </div>
        </div>

        {systemErrors.length > 0 && (
          <div className="glass-panel error-panel" style={{ gridColumn: '1 / -1', borderLeft: '4px solid #ef4444' }}>
            <div className="panel-title" style={{ color: '#ef4444' }}>System Errors & Alerts</div>
            <div className="error-logs" style={{ maxHeight: '150px', overflowY: 'auto', padding: '10px', fontFamily: 'monospace', fontSize: '12px', color: '#fca5a5' }}>
              {systemErrors.map((err, idx) => (
                <div key={idx} style={{ marginBottom: '4px' }}>• {err}</div>
              ))}
            </div>
          </div>
        )}


      </div>
    </div>
  );
}

export default App;
