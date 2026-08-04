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

const PnlChart = ({ data }: { data: number[] }) => {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const width = 100;
  const height = 100;
  
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox="0 -5 100 110" preserveAspectRatio="none" style={{ width: '100%', height: 'calc(100% - 40px)', marginTop: '40px', boxSizing: 'border-box', overflow: 'visible' }}>
      <polyline
        fill="none"
        stroke="#10b981"
        strokeWidth="3"
        points={points}
        vectorEffect="non-scaling-stroke"
      />
      <path
        fill="rgba(16, 185, 129, 0.1)"
        d={`M0,100 L${points} L100,100 Z`}
      />
    </svg>
  );
};


const SkewGraph = ({ telemetry }: { telemetry: any }) => {
  if (!telemetry || !telemetry.midPrice || telemetry.bid === 0) return (
    <div className="skew-graph-empty">Waiting for telemetry...</div>
  );
  const { bid, ask, midPrice, q } = telemetry;
  
  // We represent the spread visually
  const spread = ask - bid;
  const halfSpread = spread / 2;
  const maxView = halfSpread * 4; // visual scale
  
  // Center is midPrice
  // Calculate percentage positions
  const getPos = (price: number) => {
    let p = ((price - (midPrice - maxView)) / (maxView * 2)) * 100;
    return Math.max(0, Math.min(100, p));
  };
  
  const bidPos = getPos(bid);
  const askPos = getPos(ask);
  const midPos = getPos(midPrice);
  
  const skewPercentage = (q * 100).toFixed(1);
  const isVetoedBid = q > 0.4;
  const isVetoedAsk = q < -0.4;

  return (
    <div className="skew-graph-container" style={{ padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
      <div className="skew-graph-labels" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '12px', fontWeight: 'bold' }}>
        <span style={{color: '#10b981'}}>Bid: {bid.toFixed(2)} {isVetoedBid ? '(VETO)' : ''}</span>
        <span style={{color: '#888'}}>Mid: {midPrice.toFixed(2)}</span>
        <span style={{color: '#ef4444'}}>Ask: {ask.toFixed(2)} {isVetoedAsk ? '(VETO)' : ''}</span>
      </div>
      <div className="skew-graph-track" style={{ position: 'relative', height: '20px', background: '#333', borderRadius: '10px', overflow: 'hidden' }}>
        <div className="skew-center-line" style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: '2px', background: '#666', zIndex: 1 }}></div>
        <div className="skew-mid-dot" style={{ position: 'absolute', left: `${midPos}%`, top: '50%', transform: 'translate(-50%, -50%)', width: '8px', height: '8px', borderRadius: '50%', background: '#fff', zIndex: 2 }}></div>
        {!isVetoedBid && <div className="skew-bid-box" style={{ position: 'absolute', left: `${bidPos}%`, width: `${midPos - bidPos}%`, height: '100%', background: 'rgba(16, 185, 129, 0.5)' }}></div>}
        {!isVetoedAsk && <div className="skew-ask-box" style={{ position: 'absolute', left: `${midPos}%`, width: `${askPos - midPos}%`, height: '100%', background: 'rgba(239, 68, 68, 0.5)' }}></div>}
      </div>
      <div className="skew-stats" style={{ marginTop: '10px', fontSize: '13px', textAlign: 'center' }}>
        <span>Inventory Skew (q): <strong style={{color: Math.abs(q) > 0.3 ? '#ef4444' : '#10b981'}}>{skewPercentage}%</strong></span>
      </div>
    </div>
  );
};

function App() {
  const [gamma, setGamma] = useState<number>(0.1);
  const [baseSpreadPct, setBaseSpreadPct] = useState<number>(0.001);
  const [maxInventorySkew, setMaxInventorySkew] = useState<number>(0.4);
  const [telemetry, setTelemetry] = useState<any>(null);
  
  const [isRunning, setIsRunning] = useState(false);
  const [orderbook, setOrderbook] = useState<{ asks: OrderBookEntry[], bids: OrderBookEntry[] }>({ asks: [], bids: [] });
  const [pnl, setPnl] = useState<number | null>(null);
  const [pnlHistory, setPnlHistory] = useState<number[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  
  const [tradingMode, setTradingMode] = useState<"SIMULATION" | "LIVE">("SIMULATION");
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [liveConfirmInput, setLiveConfirmInput] = useState("");
  const [bnbDiscount, setBnbDiscount] = useState(false);
  const [activePair, setActivePair] = useState<string>("pepebrl");
  const [debouncedPair, setDebouncedPair] = useState<string>("pepebrl");
  const [systemErrors, setSystemErrors] = useState<string[]>([]);
  const [bnbDiscountLocked, setBnbDiscountLocked] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedPair(activePair), 1500);
    return () => clearTimeout(timer);
  }, [activePair]);

  const pnlRef = useRef(pnl);
  const wsRef = useRef<WebSocket | null>(null);
  const bnbDiscountRef = useRef(bnbDiscount);

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
            if (data.pnl !== undefined) {
              const newPnl = data.pnl;
              if (pnlRef.current !== null) {
              }
              setPnl(newPnl);
              pnlRef.current = newPnl;
              setPnlHistory(prev => {
                const newHistory = [...prev, newPnl];
                if (newHistory.length > 200) newHistory.shift();
                return newHistory;
              });
            }
            if (data.latency) setLatency(data.latency);
            if (data.balance !== undefined) setBalance(data.balance);
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.bestPair !== undefined) setActivePair(data.bestPair);
            if (data.isRunning !== undefined) setIsRunning(data.isRunning);
            if (data.errors !== undefined) setSystemErrors(data.errors);
                        if (data.gamma !== undefined) setGamma(data.gamma);
            if (data.baseSpreadPct !== undefined) setBaseSpreadPct(data.baseSpreadPct);
            if (data.maxInventorySkew !== undefined) setMaxInventorySkew(data.maxInventorySkew);
            if (data.bnbDiscountLocked !== undefined) setBnbDiscountLocked(data.bnbDiscountLocked);
                    } else if (data.type === 'TELEMETRY') {
            setTelemetry(data);
            if (data.gamma !== undefined) setGamma(data.gamma);
            if (data.baseSpreadPct !== undefined) setBaseSpreadPct(data.baseSpreadPct);
            if (data.maxInventorySkew !== undefined) setMaxInventorySkew(data.maxInventorySkew);
            if (data.quoteBalance !== undefined) setBalance(data.quoteBalance);
          } else if (data.type === 'STATUS') {
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.realBalance !== undefined) setBalance(data.realBalance);
            if (data.isRunning !== undefined) setIsRunning(data.isRunning);
            if (data.bnbDiscount !== undefined) {
              setBnbDiscount(data.bnbDiscount);
              bnbDiscountRef.current = data.bnbDiscount;
            }
            if (data.bnbDiscountLocked !== undefined) setBnbDiscountLocked(data.bnbDiscountLocked);
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

  const handleToggleMode = (mode: "SIMULATION" | "LIVE") => {
    if (mode === "LIVE" && tradingMode === "SIMULATION") {
      setShowLiveModal(true);
      setLiveConfirmInput("");
    } else if (mode === "SIMULATION" && tradingMode === "LIVE") {
      setTradingMode("SIMULATION");
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "SET_MODE", mode: "SIMULATION" }));
      }
    }
  };

  const confirmLiveMode = () => {
    if (liveConfirmInput === "CONFIRMAR") {
      setTradingMode("LIVE");
      setShowLiveModal(false);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "SET_MODE", mode: "LIVE" }));
      }
    }
  };


  return (
    <div className={`app-container ${tradingMode === 'LIVE' ? 'live-mode' : ''}`}>
      {showLiveModal && (
        <div className="confirmation-modal-overlay">
          <div className="confirmation-modal-content">
            <h2>⚠️ Ativar Modo LIVE</h2>
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

      <header className="header">
        <div className="header-title">
          <h1>Nexus HFT Engine</h1>
          <div className={`status-badge ${isRunning ? 'online' : 'offline'}`}>
            <div className="status-dot"></div>
            {isRunning ? 'System Active' : 'System Halted'}
          </div>
          <div className={`mode-badge ${tradingMode.toLowerCase()}`}>
            {tradingMode === 'SIMULATION' ? 'PAPER TRADING' : 'LIVE TRADING'}
          </div>
        </div>
        <div className="controls">
          <div className="mode-toggle">
            <div 
              className={`mode-toggle-option ${tradingMode === 'SIMULATION' ? 'active sim' : ''}`}
              onClick={() => handleToggleMode("SIMULATION")}
            >
              📊 SIMULATION
            </div>
            <div 
              className={`mode-toggle-option ${tradingMode === 'LIVE' ? 'active live' : ''}`}
              onClick={() => handleToggleMode("LIVE")}
            >
              ⚡ LIVE
            </div>
          </div>
          <div 
            className={`bnb-discount-toggle ${bnbDiscount ? 'active' : ''} ${bnbDiscountLocked ? 'locked' : ''}`}
            style={{ opacity: bnbDiscountLocked ? 0.5 : 1, cursor: bnbDiscountLocked ? 'not-allowed' : 'pointer' }}
            onClick={() => {
              if (bnbDiscountLocked) return;
              const newValue = !bnbDiscount;
              setBnbDiscount(newValue);
              bnbDiscountRef.current = newValue;
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "SET_BNB_DISCOUNT", enabled: newValue }));
              }
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div className="bnb-toggle-switch">
                  <div className="bnb-toggle-knob"></div>
                </div>
                <span>BNB Fee Discount {bnbDiscount ? '(-25%)' : ''}</span>
              </div>
              {bnbDiscountLocked && (
                <span style={{ fontSize: '10px', color: '#ef4444', marginTop: '4px' }}>⚠️ Insufficient BNB Balance</span>
              )}
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

      
      <div className="mm-controls-panel glass-panel" style={{ margin: '20px', padding: '20px' }}>
        <div className="panel-title" style={{ marginBottom: '15px' }}>⚡ Market Making Telemetry & Tuning</div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', alignItems: 'center' }}>
          <div>
            <div className="control-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span>Gamma (Risk Aversion):</span>
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
                <span>Base Spread:</span>
                <strong>{(baseSpreadPct * 100).toFixed(3)}%</strong>
              </label>
              <input type="range" min="0.0001" max="0.01" step="0.0001" value={baseSpreadPct} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setBaseSpreadPct(val);
                wsRef.current?.send(JSON.stringify({ type: "UPDATE_MM_PARAMS", baseSpreadPct: val }));
              }} style={{ width: '100%', accentColor: '#3b82f6' }} />
            </div>

            <div className="control-group">
              <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span>Max Inventory Skew:</span>
                <strong>{(maxInventorySkew * 100).toFixed(0)}%</strong>
              </label>
              <input type="range" min="0.1" max="0.9" step="0.05" value={maxInventorySkew} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setMaxInventorySkew(val);
                wsRef.current?.send(JSON.stringify({ type: "UPDATE_MM_PARAMS", maxInventorySkew: val }));
              }} style={{ width: '100%', accentColor: '#3b82f6' }} />
            </div>
          </div>
          
          <div className="telemetry-graph-wrapper">
             <SkewGraph telemetry={telemetry} />
          </div>
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
            {tradingMode === 'SIMULATION' ? `Base Inventory (Sim ${telemetry?.baseSymbol || ''})` : `Base Inventory (Live ${telemetry?.baseSymbol || ''})`}
          </div>
          <div className={`metric-value ${tradingMode === 'SIMULATION' ? 'simulated' : 'positive'}`}>
            {telemetry?.baseBalance !== undefined ? `${telemetry.baseBalance.toFixed(4)} ${telemetry.baseSymbol || ''}` : '--'}
          </div>
        </div>
        <div className="glass-panel metric-card">
          <div className="panel-title">
            {tradingMode === 'SIMULATION' ? `Quote Balance (Sim ${telemetry?.quoteSymbol || ''})` : `Quote Balance (Live ${telemetry?.quoteSymbol || ''})`}
          </div>
          <div className={`metric-value ${tradingMode === 'SIMULATION' ? 'simulated' : 'positive'}`}>
             {balance !== null ? `${balance.toFixed(2)}` : '--'}
          </div>
        </div>
        <div className="glass-panel metric-card">
          <div className="panel-title">Network Latency (NY4)</div>
          <div className="metric-value" style={{ color: latency !== null && latency < 10 ? 'var(--color-up)' : '#eab308' }}>
            {latency !== null ? `${latency}ms` : '--ms'}
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="glass-panel orderbook-panel">
          <div className="panel-title">Live Orderbook ({debouncedPair.toUpperCase().replace('BRL', '/BRL').replace('USDT', '/USDT')})</div>
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

        {systemErrors.length > 0 && (
          <div className="glass-panel error-panel" style={{ gridColumn: '1 / -1', borderLeft: '4px solid #ef4444' }}>
            <div className="panel-title" style={{ color: '#ef4444' }}>⚠️ System Errors & Alerts</div>
            <div className="error-logs" style={{ maxHeight: '150px', overflowY: 'auto', padding: '10px', fontFamily: 'monospace', fontSize: '12px', color: '#fca5a5' }}>
              {systemErrors.map((err, idx) => (
                <div key={idx} style={{ marginBottom: '4px' }}>• {err}</div>
              ))}
            </div>
          </div>
        )}

        <div className="glass-panel chart-panel">
          <div className="panel-title" style={{ position: 'absolute', top: '20px', left: '20px', zIndex: 10 }}>
            Performance Matrix (Real-time PnL)
          </div>
          <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <PnlChart data={pnlHistory} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
