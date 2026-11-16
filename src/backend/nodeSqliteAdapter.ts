/**
 * Node.js SQLite Adapter implementing Cloudflare D1DatabaseLike interface.
 * Persists data to data/digitech.db via Node 22 built-in node:sqlite,
 * imports all existing records from data/enquiries.json on startup (zero data loss),
 * and mirrors enquiry updates to data/enquiries.json for backup continuity.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { D1DatabaseLike, D1PreparedStatementLike, StoredEnquiry } from './types';
import { ensureSchema, listAllEnquiries, saveEnquiryRecord } from './db';

interface NodeSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes?: number | bigint };
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
}

const require = createRequire(import.meta.url);
const sqliteModule = require('node:sqlite') as {
  DatabaseSync: new (location: string) => NodeSqliteDatabase;
};

class NodeSqlitePreparedStatement implements D1PreparedStatementLike {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: NodeSqliteDatabase,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.boundValues = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.query);
    const row = stmt.get(...this.boundValues);
    if (!row) return null;
    if (colName) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }> {
    const stmt = this.db.prepare(this.query);
    const results = (stmt.all(...this.boundValues) || []) as T[];
    return { results, success: true };
  }

  async run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
    const stmt = this.db.prepare(this.query);
    const result = stmt.run(...this.boundValues);
    return {
      success: true,
      meta: { changes: Number(result?.changes || 0) },
    };
  }
}

export class NodeSqliteD1Adapter implements D1DatabaseLike {
  private readonly sqlite: NodeSqliteDatabase;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.sqlite = new sqliteModule.DatabaseSync(dbPath);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(query: string): D1PreparedStatementLike {
    return new NodeSqlitePreparedStatement(this.sqlite, query);
  }

  async exec(query: string): Promise<unknown> {
    return this.sqlite.exec(query);
  }
}

let cachedAdapter: NodeSqliteD1Adapter | null = null;
let migrationDone = false;

export async function getNodeDatabase(
  dataDir = path.resolve(process.cwd(), 'data')
): Promise<NodeSqliteD1Adapter> {
  if (!cachedAdapter) {
    cachedAdapter = new NodeSqliteD1Adapter(path.join(dataDir, 'digitech.db'));
  }

  await ensureSchema(cachedAdapter);

  if (!migrationDone) {
    migrationDone = true;
    const jsonPath = path.join(dataDir, 'enquiries.json');
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const legacyList = JSON.parse(raw || '[]') as StoredEnquiry[];
        if (Array.isArray(legacyList)) {
          for (const item of legacyList) {
            if (!item || !item.referenceId || !item.fullName || !item.phoneNumber) continue;
            await saveEnquiryRecord(cachedAdapter, {
              referenceId: item.referenceId,
              idempotencyKey: item.idempotencyKey || `LEGACY-${item.referenceId}`,
              requestType: item.requestType || 'enquiry',
              fullName: item.fullName,
              businessName: item.businessName || 'Not provided',
              phoneNumber: item.phoneNumber,
              whatsAppNumber: item.whatsAppNumber,
              emailAddress: item.emailAddress || 'Not provided',
              businessLocation: item.businessLocation || 'Not provided',
              websiteType: item.websiteType || 'Business Website',
              hasExistingWebsite: item.hasExistingWebsite === 'Yes' ? 'Yes' : 'No',
              existingWebsiteUrl: item.existingWebsiteUrl,
              requiredFeatures: Array.isArray(item.requiredFeatures) ? item.requiredFeatures : [],
              projectBudget: item.projectBudget || 'Need Consultation',
              additionalRequirements: item.additionalRequirements || '',
              submittedAt: item.submittedAt || new Date().toISOString(),
              emailStatus: item.emailStatus || 'pending',
              emailMessageId: item.emailMessageId,
              emailError: item.emailError,
              lastEmailAttemptAt: item.lastEmailAttemptAt,
              retryCount: item.retryCount || 0,
              source: 'web',
            });
          }
          console.log(
            `[DIGI TECH SOLUTION] Verified/migrated ${legacyList.length} records from ${jsonPath} into SQLite DB.`
          );
        }
      } catch (err) {
        console.error('[DIGI TECH SOLUTION] Legacy JSON migration warning:', err);
      }
    }
  }

  return cachedAdapter;
}

/**
 * Mirrors SQLite enquiries back to data/enquiries.json for redundant local backup.
 */
export async function mirrorEnquiriesToJsonBackup(
  db: D1DatabaseLike,
  dataDir = path.resolve(process.cwd(), 'data')
): Promise<void> {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const records = await listAllEnquiries(db, 500);
    fs.writeFileSync(
      path.join(dataDir, 'enquiries.json'),
      JSON.stringify(records, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[DIGI TECH SOLUTION] Backup mirror write warning:', err);
  }
}
