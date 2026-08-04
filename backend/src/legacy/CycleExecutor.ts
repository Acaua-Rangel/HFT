import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { TriangularPairs } from "./TriangularPairs";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "../infrastructure/database/ErrorLogRepository";
import { TransactionRepository } from "../infrastructure/database/TransactionRepository";
import * as crypto from "crypto";

export class CycleExecutor {
  private dustMap = new Map<string, number>();
  private readonly STABLE_ASSETS = ["USDT", "FDUSD", "BRL", "USDC"];

  constructor(
    private readonly executorProvider: () => OrderExecutor,
    private readonly errorRepo: ErrorLogRepository,
    private readonly transactionRepo: TransactionRepository
  ) {}

  public initializeDust(balances: Map<string, number>): void {
    this.dustMap = balances;
    console.log(`🧹 Dust Sweeper initialized with ${balances.size} assets from Spot Wallet.`);
  }

  // Novo método para liquidação agressiva
  private async executeFallbackIoc(executor: OrderExecutor, pair: Pair, amount: number, reason: string): Promise<void> {
    if (amount <= 0) return;
    
    // Tenta IOC 1%
    const fill1 = await this.executeWithTimeout(() => executor.executeIocSell(pair, new Amount(amount), 0.01), 5000);
    let qty1 = 0;
    fill1.apply((q) => { q.apply(v => qty1 = v); });
    
    let remainder = amount - qty1;
    if (remainder <= 0) return;

    const isFatResidue = remainder > (amount * 0.05);

    // Tenta IOC 2% - o próprio executor atualiza o midPrice ao montar a ordem
    const fill2 = await this.executeWithTimeout(() => executor.executeIocSell(pair, new Amount(remainder), 0.02), 5000);
    let qty2 = 0;
    fill2.apply((q) => { q.apply(v => qty2 = v); });
    
    const finalRemainder = remainder - qty2;

    if (finalRemainder > 0) {
      let baseSym = "";
      pair.applyCurrencies((base) => base.applySymbol(s => baseSym = s.toUpperCase()));
      
      const existing = this.dustMap.get(baseSym) || 0;
      this.dustMap.set(baseSym, existing + finalRemainder);
      
      let pairSym = "";
      pair.applyBinanceSymbol(s => pairSym = s);
      
      const msg = `Sobrou resíduo volátil pós-fallback de ${finalRemainder} ${baseSym} no par ${pairSym}. Motivo: ${reason}`;
      const type = isFatResidue ? "HIGH_PRIORITY_RESIDUE" : "DUST_RESIDUE";
      
      const entry = new ErrorLogEntry(
          { asString: () => crypto.randomUUID() } as any,
          { asNumber: () => Date.now() } as any,
          new ErrorType(type),
          new ErrorMessage(msg),
          new StackTrace(null),
          new ErrorContext(JSON.stringify({ amount: finalRemainder, original: amount }))
      );
      this.errorRepo.save(entry);
    }
  }

  public getDustMap(): Map<string, number> {
    return this.dustMap;
  }

  public getStableAssets(): string[] {
    return this.STABLE_ASSETS;
  }

  public async sweepVolatileDust(executor: OrderExecutor, pairsList: Pair[]) {
    for (const [sym, qty] of this.dustMap.entries()) {
      if (this.STABLE_ASSETS.includes(sym.toUpperCase())) continue;
      if (qty <= 0) continue;

      const liquidationPair = pairsList.find(p => {
        let base = ""; let quote = "";
        p.applyCurrencies((b, q) => { b.applySymbol(s => base = s); q.applySymbol(s => quote = s); });
        return base.toUpperCase() === sym.toUpperCase() && this.STABLE_ASSETS.includes(quote.toUpperCase());
      });

      if (liquidationPair) {
         this.dustMap.set(sym, 0); 
         await this.executeFallbackIoc(executor, liquidationPair, qty, "Daily Volatile Dust Sweep");
      }
    }
  }

  public async executeCycle(
    pairs: TriangularPairs, 
    initialAmount: Amount, 
    marginValidator: (amount: Amount) => boolean
  ): Promise<OrderFill> {
    let finalFill = OrderFill.failed();
    const executor = this.executorProvider();

    if (!executor.canExecuteBatch(3)) {
      return OrderFill.failed();
    }

    await pairs.applyAsync(async (first: Pair, second: Pair, third: Pair) => {
      try {
        const fill1 = await this.executeWithTimeout(() => executor.executeMakerBuy(first, initialAmount), 5000);
        
        let isSuccess1 = false;
        let qty1 = new Amount(0);
        fill1.apply((q, quote, p, s) => { isSuccess1 = s; qty1 = q; });

        if (!isSuccess1) {
          finalFill = OrderFill.failed();
          return;
        }

        let firstBaseSym = "";
        first.applyCurrencies((base) => base.applySymbol(s => firstBaseSym = s.toUpperCase()));
        
        let qty1Val = 0;
        qty1.apply((v) => qty1Val = v);

        let initialVal = 0;
        initialAmount.apply(v => initialVal = v);
        
        let quoteSpentVal = 0;
        fill1.apply((q, quote, p, s) => quote.apply(v => quoteSpentVal = v));
        
        if (quoteSpentVal < initialVal * 0.20) {
           await this.handleBrokenLeg(executor, first, qty1, "Preenchimento muito baixo (< 20%)");
           finalFill = OrderFill.failed();
           return;
        }

        const isStillProfitable = marginValidator(new Amount(quoteSpentVal));
        if (!isStillProfitable) {
           await this.handleBrokenLeg(executor, first, qty1, "Margem recalculada ficou negativa");
           finalFill = OrderFill.failed();
           return;
        }

        const existingDust1 = this.dustMap.get(firstBaseSym) || 0;
        const totalQty1 = qty1Val + existingDust1;
        const safeQty1 = new Amount(totalQty1);

        let isSuccess2 = false;
        let qty2 = new Amount(0);
        let quote2 = new Amount(0);

        const fill2 = await this.executeWithTimeout(() => executor.executeMakerBuy(second, safeQty1), 5000);

        fill2.apply((q, quote, p, s) => { isSuccess2 = s; qty2 = q; quote2 = quote; });

        if (!isSuccess2) {
          if (this.STABLE_ASSETS.includes(firstBaseSym)) {
            this.dustMap.set(firstBaseSym, totalQty1);
          } else {
            await this.executeFallbackIoc(executor, first, totalQty1, "Perna 2 falhou 100% com ativo volátil");
          }
          finalFill = OrderFill.failed();
          return;
        }

        let quote2Val = 0;
        quote2.apply((v) => quote2Val = v);
        const remainderBase1 = totalQty1 - quote2Val;
        if (remainderBase1 > 0) {
          if (this.STABLE_ASSETS.includes(firstBaseSym)) {
            this.dustMap.set(firstBaseSym, remainderBase1);
          } else {
            await this.executeFallbackIoc(executor, first, remainderBase1, "Resíduo parcial volátil Perna 2");
          }
        }

        let secondBaseSym = "";
        second.applyCurrencies((base) => base.applySymbol(s => secondBaseSym = s.toUpperCase()));

        let qty2Val = 0;
        qty2.apply((v) => qty2Val = v);

        const existingDust2 = this.dustMap.get(secondBaseSym) || 0;
        const totalQty2 = qty2Val + existingDust2;
        const safeQty2 = new Amount(totalQty2);

        let isSuccess3 = false;
        let qty3 = new Amount(0);

        const fill3 = await this.executeWithTimeout(() => executor.executeMakerSell(third, safeQty2), 5000);
        
        fill3.apply((q, quote, p, s) => { isSuccess3 = s; qty3 = q; });

        let qty3Val = 0;
        qty3.apply((v) => qty3Val = v);

        const residualAltcoin = totalQty2 - qty3Val;
        if (residualAltcoin > 0) {
           await this.executeFallbackIoc(executor, third, residualAltcoin, "Sobras da Perna 3 (Altcoin resíduo)");
        }

        if (!isSuccess3 && qty3Val === 0) {
          finalFill = OrderFill.failed();
          return;
        }

        finalFill = fill3;
      } catch (err) {
        finalFill = OrderFill.failed();
      }
    });

    return finalFill;
  }

  private async executeWithTimeout(operation: () => Promise<OrderFill>, timeoutMs: number): Promise<OrderFill> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(OrderFill.failed());
      }, timeoutMs);
      
      operation().then((res) => {
        clearTimeout(timeout);
        resolve(res);
      }).catch(() => {
        clearTimeout(timeout);
        resolve(OrderFill.failed());
      });
    });
  }

  private logError(type: string, message: string, pairs: TriangularPairs) {
    console.error(`[${type}] ${message} (${pairs.toString()})`);
    
    // Convert TriangularPairs to Pair string format for the DB
    const firstPair = pairs.pairTuple.first;
    const pairString = firstPair.toString();
    
    const { ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } = require("../infrastructure/database/ErrorLogRepository");
    const crypto = require("crypto");
    const { LogId, Timestamp } = require("../infrastructure/database/TransactionRepository");
    const entry = new ErrorLogEntry(
        new LogId(crypto.randomUUID()),
        new Timestamp(Date.now()),
        new ErrorType(type),
        new ErrorMessage(message),
        new StackTrace(new Error().stack || ""),
        new ErrorContext(pairString)
    );
    this.errorRepo.save(entry);
  }

  // Helper method for fallback logic mapping
  public async testFallback(pairToRevert: Pair, amountVal: number, reason: string) {
    const executor = this.executorProvider();
    await this.executeFallbackIoc(executor, pairToRevert, amountVal, reason);
  }

  private async handleBrokenLeg(executor: OrderExecutor, pairToRevert: Pair, amount: Amount, reason: string): Promise<void> {
    let amountVal = 0;
    amount.apply((v) => amountVal = v);
    await this.executeFallbackIoc(executor, pairToRevert, amountVal, reason);
    
    let symbolStr = "";
    pairToRevert.applyBinanceSymbol((s) => symbolStr = s);

    const entry = new ErrorLogEntry(
        { asString: () => crypto.randomUUID() } as any,
        { asNumber: () => Date.now() } as any,
        new ErrorType("BROKEN_LEG"),
        new ErrorMessage(`Protection triggered for ${symbolStr}: ${reason}`),
        new StackTrace(null),
        new ErrorContext(JSON.stringify({ amount: amountVal }))
    );
    this.errorRepo.save(entry);
  }
}
