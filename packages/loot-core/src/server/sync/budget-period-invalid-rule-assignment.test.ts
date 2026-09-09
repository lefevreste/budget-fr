import { Timestamp } from '@actual-app/crdt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SchemaConfig } from '#server/aql/compiler';
import { compileAndRunAqlQuery } from '#server/aql/exec';
import * as db from '#server/db';
import * as prefs from '#server/prefs';
import * as mockSyncServer from '#server/tests/mockSyncServer';
import {
  decodeStoredRuleAssignment,
  deriveStoredBudgetPeriod,
} from '#shared/budget-period';
import { q } from '#shared/query';

import { receiveMessages, setSyncingMode } from './index';
import type { Message } from './index';

const DATASET = 'budget_period_invalid_rule_probe';
const BASE_TIME = Date.now();
const CLIENT = 'INVALIDRULE00001';
const CANONICAL = '{"period":"2024-10","ruleId":"rule-1"}';
const NON_CANONICAL = '{ "period": "2024-10", "ruleId": "rule-1" }';
const INVALID_JSON = '{"period":"2024-10"';

type ProbeRow = {
  id: string;
  date: number;
  manual_budget_period: number | null;
  rule_assignment: string | number | null;
};

type AqlType = 'json' | 'json/fallback' | 'string';

beforeEach(async () => {
  setSyncingMode('enabled');
  mockSyncServer.reset();
  await global.emptyDatabase()();
  void prefs.loadPrefs();
  void prefs.savePrefs({
    groupId: 'budget-period-invalid-rule-spike',
    lastSyncedTimestamp: Timestamp.zero.toString(),
  });
  db.execQuery(`
    CREATE TABLE ${DATASET} (
      id TEXT PRIMARY KEY,
      date INTEGER NOT NULL DEFAULT 20240915,
      manual_budget_period INTEGER,
      rule_assignment TEXT
    )
  `);
});

afterEach(() => {
  setSyncingMode('disabled');
});

function schemaFor(ruleAssignmentType: AqlType) {
  return {
    [DATASET]: {
      id: { type: 'id' },
      date: { type: 'date' },
      manual_budget_period: { type: 'date-month' },
      rule_assignment: { type: ruleAssignmentType },
    },
  };
}

const schemaConfig: SchemaConfig = {};

async function readWithAql(ruleAssignmentType: AqlType, id: string) {
  const { data } = await compileAndRunAqlQuery(
    schemaFor(ruleAssignmentType),
    schemaConfig,
    q(DATASET)
      .filter({ id })
      .select(['date', 'manual_budget_period', 'rule_assignment'])
      .serialize(),
    {},
  );
  return data[0] ?? null;
}

function message(
  value: string | number | null,
  offset: number,
  id = 'transaction-1',
): Message {
  return {
    dataset: DATASET,
    row: id,
    column: 'rule_assignment',
    value,
    timestamp: new Timestamp(BASE_TIME + offset, 0, CLIENT),
  };
}

async function readRawRow(id = 'transaction-1'): Promise<ProbeRow | null> {
  return db.first<ProbeRow>(`SELECT * FROM ${DATASET} WHERE id = ?`, [id]);
}

async function readStoredProjection(id = 'transaction-1') {
  const row = await readWithAql('string', id);
  if (row === null) {
    throw new Error(`Missing probe row ${id}`);
  }
  return deriveStoredBudgetPeriod({
    bankDate: row.date,
    manualBudgetPeriod: row.manual_budget_period,
    rawRuleAssignment: row.rule_assignment,
  });
}

describe('AQL representation witnesses', () => {
  it('I09 demonstrates that AQL json collapses invalid syntax to null', async () => {
    db.runQuery(
      `INSERT INTO ${DATASET} (id, rule_assignment) VALUES (?, ?), (?, NULL)`,
      ['invalid', INVALID_JSON, 'absent'],
    );

    expect((await readWithAql('json', 'invalid'))?.rule_assignment).toBeNull();
    expect((await readWithAql('json', 'absent'))?.rule_assignment).toBeNull();
  });

  it('I10 demonstrates that json/fallback loses valid non-canonical spelling', async () => {
    db.runQuery(`INSERT INTO ${DATASET} (id, rule_assignment) VALUES (?, ?)`, [
      'non-canonical',
      NON_CANONICAL,
    ]);

    const value = (await readWithAql('json/fallback', 'non-canonical'))
      ?.rule_assignment;
    expect(value).toEqual({ period: '2024-10', ruleId: 'rule-1' });
    expect(value).not.toBe(NON_CANONICAL);
  });

  it('I11 preserves NULL and every JSON spelling through AQL string', async () => {
    const values = [
      ['absent', null],
      ['canonical', CANONICAL],
      ['non-canonical', NON_CANONICAL],
      ['invalid', INVALID_JSON],
    ] as const;
    for (const [id, value] of values) {
      db.runQuery(
        `INSERT INTO ${DATASET} (id, rule_assignment) VALUES (?, ?)`,
        [id, value],
      );
    }

    for (const [id, value] of values) {
      expect((await readWithAql('string', id))?.rule_assignment).toBe(value);
    }
  });
});

describe('synchronized invalid RuleAssignment', () => {
  it('I12 persists the exact invalid string in SQLite and messages_crdt', async () => {
    const invalid = message(INVALID_JSON, 100);

    expect(await receiveMessages([invalid])).toEqual([invalid]);
    expect((await readRawRow())?.rule_assignment).toBe(INVALID_JSON);
    expect(
      await db.first<{
        dataset: string;
        row: string;
        column: string;
        timestamp: string;
        value: string;
      }>(
        `SELECT dataset, row, column, timestamp, value
         FROM messages_crdt
         WHERE dataset = ? AND row = ? AND column = ?`,
        [DATASET, 'transaction-1', 'rule_assignment'],
      ),
    ).toEqual({
      dataset: DATASET,
      row: 'transaction-1',
      column: 'rule_assignment',
      timestamp: invalid.timestamp.toString(),
      value: `S:${INVALID_JSON}`,
    });
  });

  it('I13 blocks an invalid LWW winner without producing Default', async () => {
    await receiveMessages([message(CANONICAL, 100)]);
    await receiveMessages([message(INVALID_JSON, 200)]);

    const result = await readStoredProjection();
    expect(result).toEqual({
      ok: false,
      error: { code: 'rule-assignment-invalid-json' },
      ruleAssignment: {
        kind: 'invalid',
        raw: INVALID_JSON,
        error: { code: 'rule-assignment-invalid-json' },
      },
    });
    expect(Object.hasOwn(result, 'projection')).toBe(false);
  });

  it('I14 recovers only after a newer canonical Rule CRDT write', async () => {
    await receiveMessages([message(INVALID_JSON, 100)]);
    await receiveMessages([message(CANONICAL, 200)]);

    expect(await readStoredProjection()).toEqual({
      ok: true,
      projection: {
        budgetPeriod: '2024-10',
        budgetPeriodSource: 'rule',
      },
      ruleAssignment: {
        kind: 'valid',
        raw: CANONICAL,
        value: { period: '2024-10', ruleId: 'rule-1' },
      },
    });
    expect(
      await db.all<{ value: string }>(
        `SELECT value FROM messages_crdt
         WHERE dataset = ? AND row = ?
         ORDER BY timestamp`,
        [DATASET, 'transaction-1'],
      ),
    ).toEqual([{ value: `S:${INVALID_JSON}` }, { value: `S:${CANONICAL}` }]);
  });

  it('I15 reaches Default only after a newer explicit null CRDT write', async () => {
    await receiveMessages([message(INVALID_JSON, 100)]);
    await receiveMessages([message(null, 200)]);

    expect(await readStoredProjection()).toEqual({
      ok: true,
      projection: {
        budgetPeriod: '2024-09',
        budgetPeriodSource: 'default',
      },
      ruleAssignment: { kind: 'absent', raw: null },
    });
    expect(
      await db.all<{ value: string }>(
        `SELECT value FROM messages_crdt
         WHERE dataset = ? AND row = ?
         ORDER BY timestamp`,
        [DATASET, 'transaction-1'],
      ),
    ).toEqual([{ value: `S:${INVALID_JSON}` }, { value: '0:' }]);
  });

  it('I16 observes SQLite TEXT affinity without confusing a number with absence', async () => {
    const numeric = message(202410, 100);
    await receiveMessages([numeric]);

    expect(
      await db.first<{ rule_assignment: string; storage_type: string }>(
        `SELECT rule_assignment, typeof(rule_assignment) AS storage_type
         FROM ${DATASET} WHERE id = ?`,
        ['transaction-1'],
      ),
    ).toEqual({ rule_assignment: '202410.0', storage_type: 'text' });
    expect(
      decodeStoredRuleAssignment((await readRawRow())?.rule_assignment),
    ).toEqual({
      kind: 'invalid',
      raw: '202410.0',
      error: { code: 'rule-assignment-not-object' },
    });
    expect(
      await db.first<{ value: string }>(
        `SELECT value FROM messages_crdt
         WHERE dataset = ? AND row = ?`,
        [DATASET, 'transaction-1'],
      ),
    ).toEqual({ value: 'N:202410' });
  });

  it('I17 observes json_extract failing on invalid JSON without a fallback', async () => {
    db.runQuery(`INSERT INTO ${DATASET} (id, rule_assignment) VALUES (?, ?)`, [
      'invalid',
      INVALID_JSON,
    ]);

    await expect(
      db.first(
        `SELECT json_extract(rule_assignment, '$.period') AS period
         FROM ${DATASET} WHERE id = ?`,
        ['invalid'],
      ),
    ).rejects.toThrow();
  });
});
