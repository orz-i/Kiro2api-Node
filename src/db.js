import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class DatabaseManager {
  constructor(config) {
    this.config = config;
    this.db = null;
  }

  async init() {
    const dbPath = path.join(this.config.dataDir, 'kiro.db');
    
    // 确保数据目录存在
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }

    // 初始化数据库连接
    this.db = new Database(dbPath);
    
    // 启用 WAL 模式（提升并发性能）
    this.db.pragma('journal_mode = WAL');
    
    // 创建表结构
    this.createTables();
    
    console.log('✓ 数据库初始化完成:', dbPath);
  }

  createTables() {
    // 请求日志表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        success INTEGER DEFAULT 1,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建索引以优化查询性能
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_account_id ON request_logs(account_id);
      CREATE INDEX IF NOT EXISTS idx_model ON request_logs(model);
      CREATE INDEX IF NOT EXISTS idx_success ON request_logs(success);
      CREATE INDEX IF NOT EXISTS idx_created_at ON request_logs(created_at);
    `);

    console.log('✓ 数据库表结构创建完成');
  }

  // 插入请求日志
  insertLog(log) {
    const stmt = this.db.prepare(`
      INSERT INTO request_logs (
        timestamp, account_id, account_name, model, 
        input_tokens, output_tokens, duration_ms, success, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      log.timestamp,
      log.accountId,
      log.accountName,
      log.model || null,
      log.inputTokens || 0,
      log.outputTokens || 0,
      log.durationMs || 0,
      log.success ? 1 : 0,
      log.errorMessage || null
    );
  }

  // 获取最近的日志（分页）
  getRecentLogs(limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT 
        id,
        timestamp,
        account_id as accountId,
        account_name as accountName,
        model,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        duration_ms as durationMs,
        success,
        error_message as errorMessage
      FROM request_logs
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset);
  }

  // 获取日志统计信息
  getLogStats() {
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as totalLogs,
        SUM(input_tokens) as totalInputTokens,
        SUM(output_tokens) as totalOutputTokens,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failureCount
      FROM request_logs
    `);

    return stmt.get();
  }

  // 清空所有日志
  clearLogs() {
    this.db.exec('DELETE FROM request_logs');
    this.db.exec('VACUUM'); // 回收空间
  }

  // 自动清理旧日志（保留最近 N 条）
  cleanupOldLogs(keepCount = 100000) {
    const stmt = this.db.prepare(`
      DELETE FROM request_logs
      WHERE id NOT IN (
        SELECT id FROM request_logs
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    
    const result = stmt.run(keepCount);
    
    if (result.changes > 0) {
      this.db.exec('VACUUM');
      console.log(`✓ 清理了 ${result.changes} 条旧日志`);
    }
    
    return result.changes;
  }

  // 按时间范围统计（用于图表）
  getTimeSeriesStats(timeRange = '24h') {
    let timeCondition = '';
    
    switch (timeRange) {
      case '24h':
        timeCondition = "datetime(timestamp) >= datetime('now', '-1 day')";
        break;
      case '7d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-7 days')";
        break;
      case '30d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-30 days')";
        break;
      default:
        timeCondition = '1=1'; // 全部
    }

    const stmt = this.db.prepare(`
      SELECT 
        strftime('%Y-%m-%d %H:00:00', timestamp) as hour,
        model,
        COUNT(*) as count,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount
      FROM request_logs
      WHERE ${timeCondition}
      GROUP BY hour, model
      ORDER BY hour ASC
    `);

    return stmt.all();
  }

  // 按模型统计
  getStatsByModel(timeRange = '24h') {
    let timeCondition = '';
    
    switch (timeRange) {
      case '24h':
        timeCondition = "datetime(timestamp) >= datetime('now', '-1 day')";
        break;
      case '7d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-7 days')";
        break;
      case '30d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-30 days')";
        break;
      default:
        timeCondition = '1=1';
    }

    const stmt = this.db.prepare(`
      SELECT 
        model,
        COUNT(*) as count,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens,
        AVG(duration_ms) as avgDuration,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount
      FROM request_logs
      WHERE ${timeCondition} AND model IS NOT NULL
      GROUP BY model
      ORDER BY count DESC
    `);

    return stmt.all();
  }

  // 按账号统计（Top N）
  getStatsByAccount(limit = 10, timeRange = '24h') {
    let timeCondition = '';
    
    switch (timeRange) {
      case '24h':
        timeCondition = "datetime(timestamp) >= datetime('now', '-1 day')";
        break;
      case '7d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-7 days')";
        break;
      case '30d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-30 days')";
        break;
      default:
        timeCondition = '1=1';
    }

    const stmt = this.db.prepare(`
      SELECT 
        account_name as accountName,
        COUNT(*) as count,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount
      FROM request_logs
      WHERE ${timeCondition}
      GROUP BY account_id, account_name
      ORDER BY count DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  // 获取成功率统计
  getSuccessRateStats(timeRange = '24h') {
    let timeCondition = '';
    
    switch (timeRange) {
      case '24h':
        timeCondition = "datetime(timestamp) >= datetime('now', '-1 day')";
        break;
      case '7d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-7 days')";
        break;
      case '30d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-30 days')";
        break;
      default:
        timeCondition = '1=1';
    }

    const stmt = this.db.prepare(`
      SELECT 
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failureCount,
        COUNT(*) as totalCount
      FROM request_logs
      WHERE ${timeCondition}
    `);

    return stmt.get();
  }

  // Token 消耗趋势
  getTokenTrends(timeRange = '24h') {
    let timeCondition = '';
    
    switch (timeRange) {
      case '24h':
        timeCondition = "datetime(timestamp) >= datetime('now', '-1 day')";
        break;
      case '7d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-7 days')";
        break;
      case '30d':
        timeCondition = "datetime(timestamp) >= datetime('now', '-30 days')";
        break;
      default:
        timeCondition = '1=1';
    }

    const stmt = this.db.prepare(`
      SELECT 
        strftime('%Y-%m-%d %H:00:00', timestamp) as hour,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens
      FROM request_logs
      WHERE ${timeCondition}
      GROUP BY hour
      ORDER BY hour ASC
    `);

    return stmt.all();
  }

  // 关闭数据库连接
  close() {
    if (this.db) {
      this.db.close();
      console.log('✓ 数据库连接已关闭');
    }
  }
}
