# HFT Triangular Arbitrage Engine & Real-Time Dashboard

A High-Frequency Trading (HFT) system focused on Triangular Arbitrage on the Binance exchange, built with Domain-Driven Design (DDD) principles using Bun and TypeScript for the backend and a real-time monitoring dashboard using React and Vite for the frontend.

---

## Overview

This project is engineered to capture momentary price inefficiencies across cryptocurrency trading triplets on Binance with millisecond execution speeds.

### Key Architectural Highlights
* **Ultra-Low Latency with Bun:** Built on the high-performance Bun runtime to optimize tick processing speeds.
* **Persistent WebSocket Infrastructure:** Direct order book ingestion and signal execution via Binance WebSockets to minimize network overhead.
* **Dual Execution Modes:**
  * **LIVE:** Real order execution using Binance API credentials.
  * **SIMULATION:** Realistic execution against local order books using virtual balances for risk-free testing.
* **Dynamic BNB Fee Discounts:** Automated fee calculations supporting the 25% BNB fee discount option.
* **Real-Time Telemetry:** Internal WebSocket server streaming live metrics (PnL, RTT latency, balance, volume) to the dashboard at 20 updates per second.
* **Asynchronous SQLite Persistence:** Non-blocking transaction logging and audit tracking to ensure zero performance impact on the main evaluation loop.

---

## Tech Stack

### Backend (`/backend`)
* **Runtime:** Bun (TypeScript)
* **External APIs:** Binance WebSocket & REST APIs
* **Database:** SQLite (via `bun:sqlite`)
* **Architecture:** Domain-Driven Design (DDD) - Entities, Value Objects, Application Services, Infrastructure

### Frontend (`/frontend`)
* **Framework:** React 18 + TypeScript
* **Build Tool:** Vite
* **Styling:** CSS3 / Modern Dark Theme UI
* **Communication:** WebSockets for real-time telemetry streaming

---

## Repository Structure

```text
HFT/
├── backend/                        # HFT Core Engine (Bun + TypeScript)
│   ├── src/
│   │   ├── application/            # Cycle evaluation, math engine, and execution
│   │   │   ├── ArbitrageMathEngine.ts
│   │   │   ├── CycleEvaluator.ts
│   │   │   ├── CycleExecutor.ts
│   │   │   ├── LocalStateManager.ts
│   │   │   └── TriangularPairs.ts
│   │   ├── domain/                 # Domain entities and value objects
│   │   │   ├── entities/OrderBook.ts
│   │   │   └── valueObjects/
│   │   └── infrastructure/         # Binance integration, SQLite, simulators
│   │       ├── BinanceWsClient.ts
│   │       ├── BinanceOrderExecutor.ts
│   │       ├── BinancePriceIngestor.ts
│   │       └── database/
│   ├── index.ts                    # Main entry point and telemetry WS server
│   └── package.json
│
├── frontend/                       # Monitoring Dashboard (React + Vite)
│   ├── src/                        # UI Components
│   ├── index.html
│   └── package.json
│
└── README.md                       # Main documentation
```

---

## Getting Started

### Prerequisites
* Bun (v1.1 or higher)
* Node.js (v18 or higher) and `npm`
* Binance API Account (for LIVE execution mode)

---

### 1. Backend Setup

Navigate to the backend directory:
```bash
cd backend
```

Install dependencies:
```bash
bun install
```

Configure environment variables in a `.env` file:
```env
BINANCE_API_KEY=your_api_key_here
BINANCE_API_SECRET=your_api_secret_here
TRADING_MODE=SIMULATION         # 'SIMULATION' or 'LIVE'
SIMULATION_BALANCE=1000         # Initial virtual balance in BRL/USDT
BNB_DISCOUNT=true               # Enable BNB fee discount (true/false)
```

Start the HFT engine:
```bash
bun run index.ts
```

---

### 2. Frontend Setup (Dashboard)

In a separate terminal window, navigate to the frontend directory:
```bash
cd frontend
```

Install dependencies:
```bash
npm install
```

Start the development server:
```bash
npm run dev
```

Open your browser at `http://localhost:5173`.

---

## Production Deployment & Low-Latency Setup (AWS)

To achieve optimal latency against the Binance matching engine:

* **Target AWS Region:** Tokyo (`ap-northeast-1`).
* **Recommended EC2 Instance:** `c7g.large` (ARM Graviton3) or `c6i.large` (Intel) with Enhanced Networking (ENA) enabled.
* **Process Manager:** PM2 or systemd for 24/7 continuous operation.

### Running in Production with PM2:
```bash
bun install -g pm2
pm2 start index.ts --name "hft-engine" --interpreter bun
pm2 startup
pm2 save
```

---

## Disclaimer

This software is developed for educational and research purposes concerning high-frequency trading and arbitrage algorithms. Cryptocurrency markets carry significant financial risks. The authors assume no liability for financial losses incurred through the deployment of this software.

---

## License

Distributed under the MIT License. See `LICENSE` for more information.
