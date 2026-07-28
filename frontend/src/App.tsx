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
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', marginTop: '40px', boxSizing: 'border-box' }}>
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
  
  const pnlRef = useRef(pnl);

  useEffect(() => {
    let ws: WebSocket;

    if (isRunning) {
      ws = new WebSocket('ws://localhost:3000');
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'UPDATE') {
            if (data.pnl) {
              const newPnl = data.pnl;
              if (pnlRef.current !== null) {
                if (newPnl > pnlRef.current) setPnlFlash('flash-up');
                else if (newPnl < pnlRef.current) setPnlFlash('flash-down');
              }
              
              setPnl(newPnl);
              pnlRef.current = newPnl;
              setPnlHistory(prev => {
                const newHistory = [...prev, newPnl];
                if (newHistory.length > 50) newHistory.shift();
                return newHistory;
              });
              
              setTimeout(() => setPnlFlash(''), 300);
            }
            if (data.latency) setLatency(data.latency);
            if (data.volume) setVolume(v => v + data.volume);
            if (data.balance !== undefined) setBalance(data.balance);
          }
        } catch (e) {
          console.error("Invalid WS message");
        }
      };
    }

    let binanceWs: WebSocket;
    if (isRunning) {
      binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcbrl@depth20@100ms');
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
      if (ws) ws.close();
      if (binanceWs) binanceWs.close();
    };
  }, [isRunning]);

  const maxTotal = Math.max(
    orderbook.asks[0]?.total || 1,
    orderbook.bids[orderbook.bids.length - 1]?.total || 1
  );

  return (
    <div className="app-container">
      <header className="header">
        <div className="header-title">
          <h1>Nexus HFT Engine</h1>
          <div className={`status-badge ${isRunning ? 'online' : 'offline'}`}>
            <div className="status-dot"></div>
            {isRunning ? 'System Active' : 'System Halted'}
          </div>
        </div>
        <div className="controls">
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
          <div className="panel-title">Margem Teórica (Ciclo)</div>
          <div className={`metric-value ${pnl !== null ? (pnl >= 0 ? 'positive' : 'negative') : ''} ${pnlFlash}`}>
            {pnl !== null ? `${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}` : '--'}
          </div>
        </div>
        <div className="glass-panel metric-card">
          <div className="panel-title">BRL Balance (Live)</div>
          <div className="metric-value positive">
            {balance !== null ? `R$ ${balance.toFixed(2)}` : '--'}
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
          <div className="panel-title">Live Orderbook (BTC/BRL)</div>
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
