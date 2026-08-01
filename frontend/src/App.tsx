import { useState, useEffect, useRef } from 'react';
import './App.css';

interface OrderBookEntry {
  price: number;
  size: number;
  total: number;
}

// Removed synthetic generateOrderBook

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value);
};

const formatNumber = (value: number) => {
  return new Intl.NumberFormat('en-US').format(value);
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

function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [orderbook, setOrderbook] = useState<{ asks: OrderBookEntry[], bids: OrderBookEntry[] }>({ asks: [], bids: [] });
  const [pnl, setPnl] = useState<number | null>(null);
  const [pnlHistory, setPnlHistory] = useState<number[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [pnlFlash, setPnlFlash] = useState<'flash-up' | 'flash-down' | ''>('');
  
  const [tradingMode, setTradingMode] = useState<"SIMULATION" | "LIVE">("SIMULATION");
  const [simBalance, setSimBalance] = useState<number | null>(null);
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [liveConfirmInput, setLiveConfirmInput] = useState("");
  const [isEditingSimBalance, setIsEditingSimBalance] = useState(false);
  const [simBalanceInput, setSimBalanceInput] = useState("");
  const [bnbDiscount, setBnbDiscount] = useState(false);
  const [activePair, setActivePair] = useState<string>("pepebrl");

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
                if (newPnl > pnlRef.current) setPnlFlash('flash-up');
                else if (newPnl < pnlRef.current) setPnlFlash('flash-down');
              }
              setPnl(newPnl);
              pnlRef.current = newPnl;
              setPnlHistory(prev => {
                const newHistory = [...prev, newPnl];
                if (newHistory.length > 200) newHistory.shift();
                return newHistory;
              });
              setTimeout(() => setPnlFlash(''), 300);
            }
            if (data.latency) setLatency(data.latency);
            if (data.volume) setVolume(v => v + data.volume);
            if (data.balance !== undefined) setBalance(data.balance);
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.simBalance !== undefined) setSimBalance(data.simBalance);
            if (data.bestPair !== undefined) setActivePair(data.bestPair);
          } else if (data.type === 'STATUS') {
            if (data.mode !== undefined) setTradingMode(data.mode);
            if (data.simBalance !== undefined) setSimBalance(data.simBalance);
            if (data.realBalance !== undefined) setBalance(data.realBalance);
            if (data.bnbDiscount !== undefined) {
              setBnbDiscount(data.bnbDiscount);
              bnbDiscountRef.current = data.bnbDiscount;
            }
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
          binanceWsUrl = binanceWsUrl.replace(/\/ws\/[^@]+@/, `/ws/${activePair}@`);
      } else {
          binanceWsUrl = `wss://stream.binance.com:9443/ws/${activePair}@depth20@100ms`;
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
  }, [isRunning, activePair]);

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

  const handleSimBalanceSubmit = () => {
    const amount = parseFloat(simBalanceInput);
    if (!isNaN(amount) && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "SET_SIM_BALANCE", amount }));
    }
    setIsEditingSimBalance(false);
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
            className={`bnb-discount-toggle ${bnbDiscount ? 'active' : ''}`}
            onClick={() => {
              const newValue = !bnbDiscount;
              setBnbDiscount(newValue);
              bnbDiscountRef.current = newValue;
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: "SET_BNB_DISCOUNT", enabled: newValue }));
              }
            }}
          >
            <div className="bnb-toggle-switch">
              <div className="bnb-toggle-knob"></div>
            </div>
            <span>BNB Fee Discount {bnbDiscount ? '(-25%)' : ''}</span>
          </div>
          {!isRunning ? (
            <button className="btn btn-start" onClick={() => setIsRunning(true)}>
              INITIATE ENGINE
            </button>
          ) : (
            <button className="btn btn-stop" onClick={() => setIsRunning(false)}>
              HALT TRADING
            </button>
          )}
        </div>
      </header>

      <div className="metrics-row">
        <div className="glass-panel metric-card">
          <div className="panel-title">Melhor Margem HFT (Multi-Cycle)</div>
          <div className={`metric-value ${pnl !== null ? (pnl >= 0 ? 'positive' : 'negative') : ''} ${pnlFlash}`}>
            {pnl !== null ? `${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}` : '--'}
          </div>
        </div>
        <div className="glass-panel metric-card">
          <div className="panel-title">
            {tradingMode === 'SIMULATION' ? 'BRL Balance (Simulated)' : 'BRL Balance (Live)'}
            {tradingMode === 'SIMULATION' && (
              <span className="edit-sim-balance" onClick={() => {
                setIsEditingSimBalance(!isEditingSimBalance);
                if (!isEditingSimBalance) setSimBalanceInput(simBalance?.toString() || "");
              }}>
                ✏️
              </span>
            )}
          </div>
          <div className={`metric-value ${tradingMode === 'SIMULATION' ? 'simulated' : 'positive'}`}>
            {tradingMode === 'SIMULATION' ? (
              isEditingSimBalance ? (
                <div className="sim-balance-edit-container">
                  <input 
                    type="number" 
                    className="sim-balance-edit"
                    value={simBalanceInput} 
                    onChange={e => setSimBalanceInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSimBalanceSubmit()}
                    autoFocus
                  />
                  <span className="sim-balance-confirm" onClick={handleSimBalanceSubmit}>✔️</span>
                </div>
              ) : (
                simBalance !== null ? `R$ ${simBalance.toFixed(2)}` : '--'
              )
            ) : (
              balance !== null ? `R$ ${balance.toFixed(2)}` : '--'
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
          <div className="panel-title">Volume (Contracts)</div>
          <div className="metric-value">
            {volume !== null ? formatNumber(volume) : '--,---,---'}
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="glass-panel orderbook-panel">
          <div className="panel-title">Live Orderbook ({activePair.toUpperCase().replace('BRL', '/BRL').replace('USDT', '/USDT')})</div>
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
                    <td className="price-ask">{ask.price.toFixed(2)}</td>
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
              Spread: {((orderbook.asks[orderbook.asks.length - 1]?.price || 0) - (orderbook.bids[0]?.price || 0)).toFixed(2)}
            </div>

            <table className="orderbook-table">
              <tbody>
                {orderbook.bids.map((bid, idx) => (
                  <tr key={`bid-${idx}`}>
                    <td className="price-bid">{bid.price.toFixed(2)}</td>
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
