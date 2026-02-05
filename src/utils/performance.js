/**
 * Performance tracking for predictions
 */
import fs from 'node:fs';
import path from 'node:path';

class PerformanceTracker {
  constructor() {
    this.predictions = [];
    this.logPath = './logs/performance.json';
    this.loadFromFile();
  }

  recordPrediction({ marketSlug, predictedDirection, priceToBeat, currentPrice, timestamp, modelProb }) {
    this.predictions.push({
      marketSlug,
      predictedDirection,
      priceToBeat,
      entryPrice: currentPrice,
      entryTime: timestamp,
      modelProb,
      settled: false,
      correct: null,
      finalPrice: null,
      settlementTime: null
    });
    
    this.saveToFile();
  }

  recordSettlement({ marketSlug, finalPrice, timestamp }) {
    const pred = this.predictions.find(p => p.marketSlug === marketSlug && !p.settled);
    if (!pred) return;
    
    pred.settled = true;
    pred.settlementTime = timestamp;
    pred.finalPrice = finalPrice;
    pred.correct = (pred.predictedDirection === 'UP' && finalPrice > pred.priceToBeat) ||
                   (pred.predictedDirection === 'DOWN' && finalPrice < pred.priceToBeat);
    
    this.saveToFile();
  }

  getStats() {
    const settled = this.predictions.filter(p => p.settled);
    const correct = settled.filter(p => p.correct).length;
    const last10 = settled.slice(-10);
    const last10Correct = last10.filter(p => p.correct).length;
    
    return {
      total: settled.length,
      correct,
      accuracy: settled.length > 0 ? (correct / settled.length * 100).toFixed(1) : 0,
      last10Accuracy: last10.length > 0 ? (last10Correct / last10.length * 100).toFixed(1) : 0,
      pending: this.predictions.filter(p => !p.settled).length
    };
  }

  saveToFile() {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.writeFileSync(this.logPath, JSON.stringify(this.predictions, null, 2), 'utf8');
    } catch (err) {
      console.error('[PerformanceTracker] Failed to save:', err.message);
    }
  }

  loadFromFile() {
    try {
      if (fs.existsSync(this.logPath)) {
        const data = fs.readFileSync(this.logPath, 'utf8');
        this.predictions = JSON.parse(data);
      }
    } catch (err) {
      console.error('[PerformanceTracker] Failed to load:', err.message);
      this.predictions = [];
    }
  }
}

export const performanceTracker = new PerformanceTracker();
