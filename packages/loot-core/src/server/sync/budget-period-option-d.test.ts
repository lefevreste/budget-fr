import { Timestamp } from '@actual-app/crdt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SchemaConfig } from '#server/aql/compiler';
import { compileAndRunAqlQuery } from '#server/aql/exec';
import { convertForUpdate } from '#server/aql/schema-helpers';
import * as db from '#server/db';
import * as prefs from '#server/prefs';
import * as mockSyncServer from '#server/tests/mockSyncServer';
import { q } from '#shared/query';

import {
  applyMessages,
  batchMessages,
  sendMessages,
  setSyncingMode,
} from './index';
import type { Message } from './index';

const JSON_DATASET = 'budget_period_option_d_json_probe';
const TEXT_DATASET = 'budget_period_option_d_text_probe';
const RULE_DATASET = 'budget_period_option_d_rule_probe';
const JSON_VIEW = 'v_budget_period_option_d_json_probe';
const TEXT_VIEW = 'v_budget_period_option_d_text_probe';
const ROW_ID = 'transaction-1';
const BASE_TIME = Date.parse('2020-01-01T00:00:00.000Z');
const RULE_CLIENT = 'RULE000000000001';
const MANUAL_CLIENT = 'MANUAL0000000001';
const RESET_CLIENT = 'RESET00000000001';
const SECOND_CLIENT = 'SECOND0000000001';

const JSON_RULE_PERIOD_SQL =
  "CAST(REPLACE(json_extract(rule_assignment, '$.period'), '-', '') AS INTEGER)";
const TEXT_RULE_PERIOD_SQL = 'CAST(SUBSTR(rule_assignment, 1, 6) AS INTEGER)';
const DEFAULT_PERIOD_SQL = 'CAST(date / 100 AS INTEGER)';

type RuleAssignment = {
  period: string;
  ruleId: string;
};

type DerivedSource = 'default' | 'rule' | 'manual';

type ProbeRow = {
  id: string;
  date: number;
  amount: number;
  manual_budget_period: number | null;
  rule_assignment: string | null;
};

type EffectiveState = {
  manualBudgetPeriod: number | null;
  ruleAssignment: RuleAssignment | null;
  source: DerivedSource;
  effectiveBudgetPeriod: number;
};

type RuleEncoding = {
  name: 'json' | 'text';
  dataset: typeof JSON_DATASET | typeof TEXT_DATASET;
  view: typeof JSON_VIEW | typeof TEXT_VIEW;
  aqlType: 'json' | 'string';
  rulePeriodSql: string;
  encode: (assignment: RuleAssignment) => string;
  decode: (value: string) => RuleAssignment;
};

const RULE_ONE: RuleAssignment = {
  period: '2024-10',
  ruleId: 'rule-1',
};

const RULE_TWO: RuleAssignment = {
  period: '2024-12',
  ruleId: 'rule/2|replacement',
};

beforeEach(async () => {
  setSyncingMode('enabled');
  await resetProbeDatabase();
});

afterEach(() => {
  setSyncingMode('disabled');
});

function assertRuleAssignment(value: unknown): RuleAssignment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('rule_assignment must be an object');
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, 'period') ||
    !Object.hasOwn(value, 'ruleId')
  ) {
    throw new Error('rule_assignment must contain exactly period and ruleId');
  }

  const period = Reflect.get(value, 'period');
  const ruleId = Reflect.get(value, 'ruleId');
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error('rule_assignment period must use YYYY-MM');
  }
  if (typeof ruleId !== 'string' || ruleId.length === 0) {
    throw new Error('rule_assignment ruleId must be a non-empty string');
  }

  return { period, ruleId };
}

function encodeCanonicalJson(assignment: RuleAssignment): string {
  const valid = assertRuleAssignment(assignment);
  return JSON.stringify({ period: valid.period, ruleId: valid.ruleId });
}

function decodeCanonicalJson(value: string): RuleAssignment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('rule_assignment must be valid JSON');
  }

  const assignment = assertRuleAssignment(parsed);
  if (encodeCanonicalJson(assignment) !== value) {
    throw new Error('rule_assignment JSON must use its canonical encoding');
  }
  return assignment;
}

function encodeCanonicalText(assignment: RuleAssignment): string {
  const valid = assertRuleAssignment(assignment);
  return `${valid.period.replace('-', '')}|${encodeURIComponent(valid.ruleId)}`;
}

function decodeCanonicalText(value: string): RuleAssignment {
  if (!/^\d{6}\|/.test(value)) {
    throw new Error('rule_assignment text must start with YYYYMM|');
  }

  let ruleId: string;
  try {
    ruleId = decodeURIComponent(value.slice(7));
  } catch {
    throw new Error('rule_assignment text contains an invalid encoded ruleId');
  }

  const assignment = assertRuleAssignment({
    period: `${value.slice(0, 4)}-${value.slice(4, 6)}`,
    ruleId,
  });
  if (encodeCanonicalText(assignment) !== value) {
    throw new Error('rule_assignment text must use its canonical encoding');
  }
  return assignment;
}

const ENCODINGS: readonly RuleEncoding[] = [
  {
    name: 'json',
    dataset: JSON_DATASET,
    view: JSON_VIEW,
    aqlType: 'json',
    rulePeriodSql: JSON_RULE_PERIOD_SQL,
    encode: encodeCanonicalJson,
    decode: decodeCanonicalJson,
  },
  {
    name: 'text',
    dataset: TEXT_DATASET,
    view: TEXT_VIEW,
    aqlType: 'string',
    rulePeriodSql: TEXT_RULE_PERIOD_SQL,
    encode: encodeCanonicalText,
    decode: decodeCanonicalText,
  },
];

function effectivePeriodSql(rulePeriodSql: string): string {
  return `COALESCE(manual_budget_period, ${rulePeriodSql}, ${DEFAULT_PERIOD_SQL})`;
}

function createProbeTable(dataset: string): void {
  db.execQuery(`
    CREATE TABLE ${dataset} (
      id TEXT PRIMARY KEY,
      date INTEGER NOT NULL DEFAULT 20240915,
      amount INTEGER NOT NULL DEFAULT 0,
      manual_budget_period INTEGER,
      rule_assignment TEXT
    )
  `);
}

function createProbeView(encoding: RuleEncoding): void {
  db.execQuery(`
    CREATE VIEW ${encoding.view} AS
    SELECT
      id,
      date,
      amount,
      manual_budget_period,
      rule_assignment,
      CASE
        WHEN manual_budget_period IS NOT NULL THEN 'manual'
        WHEN rule_assignment IS NOT NULL THEN 'rule'
        ELSE 'default'
      END AS derived_source,
      ${effectivePeriodSql(encoding.rulePeriodSql)} AS effective_budget_period
    FROM ${encoding.dataset}
  `);
}

async function resetProbeDatabase(): Promise<void> {
  mockSyncServer.reset();
  await global.emptyDatabase()();
  void prefs.loadPrefs();
  void prefs.savePrefs({
    groupId: 'budget-period-option-d-spike',
    lastSyncedTimestamp: Timestamp.zero.toString(),
  });

  for (const encoding of ENCODINGS) {
    createProbeTable(encoding.dataset);
    createProbeView(encoding);
  }

  db.execQuery(`
    CREATE TABLE ${RULE_DATASET} (
      id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1,
      tombstone INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function hulc(offset: number, node: string): Timestamp {
  return new Timestamp(BASE_TIME + offset, 0, node);
}

function nextHulc(): Timestamp {
  const timestamp = Timestamp.send();
  if (timestamp === null) {
    throw new Error('The HULC clock is not initialized');
  }
  return timestamp;
}

function probeMessage(
  encoding: RuleEncoding,
  row: string,
  column: 'manual_budget_period' | 'rule_assignment',
  value: string | number | null,
  offset: number,
  node: string,
): Message {
  return {
    dataset: encoding.dataset,
    row,
    column,
    value,
    timestamp: hulc(offset, node),
  };
}

function manualMessage(
  encoding: RuleEncoding,
  period: number | null,
  offset: number,
  node = MANUAL_CLIENT,
  row = ROW_ID,
): Message {
  return probeMessage(
    encoding,
    row,
    'manual_budget_period',
    period,
    offset,
    node,
  );
}

function ruleMessage(
  encoding: RuleEncoding,
  assignment: RuleAssignment | null,
  offset: number,
  node = RULE_CLIENT,
  row = ROW_ID,
): Message {
  return probeMessage(
    encoding,
    row,
    'rule_assignment',
    assignment === null ? null : encoding.encode(assignment),
    offset,
    node,
  );
}

function externalRuleMessage(
  column: 'active' | 'tombstone',
  value: number,
  offset: number,
): Message {
  return {
    dataset: RULE_DATASET,
    row: RULE_ONE.ruleId,
    column,
    value,
    timestamp: hulc(offset, RULE_CLIENT),
  };
}

async function readProbeRow(
  encoding: RuleEncoding,
  row = ROW_ID,
): Promise<ProbeRow | null> {
  return db.first<ProbeRow>(`SELECT * FROM ${encoding.dataset} WHERE id = ?`, [
    row,
  ]);
}

function toPeriodInteger(period: string): number {
  return Number(period.replace('-', ''));
}

async function readEffectiveState(
  encoding: RuleEncoding,
  row = ROW_ID,
): Promise<EffectiveState> {
  const probe = await readProbeRow(encoding, row);
  if (probe === null) {
    throw new Error(`Missing probe row ${row}`);
  }

  const ruleAssignment =
    probe.rule_assignment === null
      ? null
      : encoding.decode(probe.rule_assignment);
  const source: DerivedSource =
    probe.manual_budget_period !== null
      ? 'manual'
      : ruleAssignment !== null
        ? 'rule'
        : 'default';

  return {
    manualBudgetPeriod: probe.manual_budget_period,
    ruleAssignment,
    source,
    effectiveBudgetPeriod:
      probe.manual_budget_period ??
      (ruleAssignment === null
        ? Math.floor(probe.date / 100)
        : toPeriodInteger(ruleAssignment.period)),
  };
}

function expectedState(
  manualBudgetPeriod: number | null,
  ruleAssignment: RuleAssignment | null,
): EffectiveState {
  return {
    manualBudgetPeriod,
    ruleAssignment,
    source:
      manualBudgetPeriod !== null
        ? 'manual'
        : ruleAssignment !== null
          ? 'rule'
          : 'default',
    effectiveBudgetPeriod:
      manualBudgetPeriod ??
      (ruleAssignment === null
        ? 202409
        : toPeriodInteger(ruleAssignment.period)),
  };
}

async function readPersistedMessages(
  encoding: RuleEncoding,
  row = ROW_ID,
): Promise<Array<Pick<db.DbCrdtMessage, 'column' | 'timestamp' | 'value'>>> {
  return db.all<Pick<db.DbCrdtMessage, 'column' | 'timestamp' | 'value'>>(
    `SELECT column, timestamp, value
     FROM messages_crdt
     WHERE dataset = ? AND row = ?
     ORDER BY timestamp`,
    [encoding.dataset, row],
  );
}

function deliveryPlans(messages: readonly Message[]): Message[][][] {
  const forward = messages.map(message => [message]);
  const reverse = [...messages].reverse().map(message => [message]);
  const even = messages.filter((_, index) => index % 2 === 0);
  const odd = messages.filter((_, index) => index % 2 === 1);

  return [
    [[...messages]],
    forward,
    reverse,
    [even, odd].filter(chunk => chunk.length > 0),
  ];
}

async function expectConvergence(
  encoding: RuleEncoding,
  messages: readonly Message[],
  expected: EffectiveState,
  row = ROW_ID,
): Promise<void> {
  let referenceMessages:
    | Array<Pick<db.DbCrdtMessage, 'column' | 'timestamp' | 'value'>>
    | undefined;

  for (const plan of deliveryPlans(messages)) {
    await resetProbeDatabase();
    for (const chunk of plan) {
      await applyMessages(chunk);
    }

    expect(await readEffectiveState(encoding, row)).toEqual(expected);
    const persisted = await readPersistedMessages(encoding, row);
    if (referenceMessages === undefined) {
      referenceMessages = persisted;
    } else {
      expect(persisted).toEqual(referenceMessages);
    }
  }
}

function schemaFor(encoding: RuleEncoding) {
  return {
    [encoding.dataset]: {
      id: { type: 'id' },
      date: { type: 'date', required: true },
      amount: { type: 'integer', required: true },
      manual_budget_period: { type: 'date-month' },
      rule_assignment: { type: encoding.aqlType },
      derived_source: { type: 'string' },
      effective_budget_period: { type: 'date-month' },
    },
  };
}

function schemaConfigFor(encoding: RuleEncoding): SchemaConfig {
  return {
    tableViews: {
      [encoding.dataset]: encoding.view,
    },
  };
}

function logicalRuleAssignment(
  encoding: RuleEncoding,
  assignment: RuleAssignment | null,
): RuleAssignment | string | null {
  if (assignment === null || encoding.name === 'json') {
    return assignment;
  }
  return encoding.encode(assignment);
}

async function writeThroughAqlConversion(
  encoding: RuleEncoding,
  row: {
    id: string;
    date: string;
    amount: number;
    manual_budget_period?: string | null;
    rule_assignment?: RuleAssignment | null;
  },
): Promise<void> {
  const converted: Record<string, unknown> = convertForUpdate(
    schemaFor(encoding),
    schemaConfigFor(encoding),
    encoding.dataset,
    {
      ...row,
      rule_assignment: logicalRuleAssignment(
        encoding,
        row.rule_assignment ?? null,
      ),
    },
  );
  await db.update(encoding.dataset, converted);
}

async function runAql(
  encoding: RuleEncoding,
  queryState: ReturnType<typeof q>['state'],
) {
  return compileAndRunAqlQuery(
    schemaFor(encoding),
    schemaConfigFor(encoding),
    queryState,
    {},
  );
}

describe('Budget period option D CRDT spike', () => {
  describe.each(ENCODINGS)('$name rule_assignment encoding', encoding => {
    it('uses db.update, sendMessages and batchMessages without persisting source', async () => {
      await batchMessages(async () => {
        await db.update(encoding.dataset, {
          id: ROW_ID,
          manual_budget_period: 202411,
        });
        await sendMessages([
          {
            dataset: encoding.dataset,
            row: ROW_ID,
            column: 'rule_assignment',
            value: encoding.encode(RULE_ONE),
            timestamp: nextHulc(),
          },
        ]);
      });

      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(202411, RULE_ONE),
      );
      expect(await readPersistedMessages(encoding)).toHaveLength(2);
      expect(
        mockSyncServer
          .getMessages()
          .filter(message => message.dataset === encoding.dataset)
          .map(message => message.column),
      ).toEqual(['manual_budget_period', 'rule_assignment']);

      const columns = await db.all<{ name: string }>(
        `PRAGMA table_info(${encoding.dataset})`,
      );
      expect(columns.map(column => column.name)).not.toContain('source');
    });

    it('keeps a non-null Manual effective across older and newer Rule writes', async () => {
      const messages = [
        ruleMessage(encoding, RULE_ONE, 100),
        manualMessage(encoding, 202411, 200),
        ruleMessage(encoding, RULE_TWO, 300, SECOND_CLIENT),
      ];

      await expectConvergence(
        encoding,
        messages,
        expectedState(202411, RULE_TWO),
      );
    });

    it('reveals an earlier Rule when the winning Manual value is deleted', async () => {
      const messages = [
        ruleMessage(encoding, RULE_ONE, 100),
        manualMessage(encoding, 202411, 200),
        manualMessage(encoding, null, 300, RESET_CLIENT),
      ];

      await expectConvergence(
        encoding,
        messages,
        expectedState(null, RULE_ONE),
      );
    });

    it('resolves two Manual values and a Manual deletion within one cell', async () => {
      await expectConvergence(
        encoding,
        [
          manualMessage(encoding, 202410, 100),
          manualMessage(encoding, 202412, 200, SECOND_CLIENT),
        ],
        expectedState(202412, null),
      );

      await expectConvergence(
        encoding,
        [
          manualMessage(encoding, 202412, 200, SECOND_CLIENT),
          manualMessage(encoding, null, 300, RESET_CLIENT),
        ],
        expectedState(null, null),
      );
    });

    it('resolves two Rule values and Rule deletion as indivisible cell values', async () => {
      await expectConvergence(
        encoding,
        [
          ruleMessage(encoding, RULE_ONE, 100),
          ruleMessage(encoding, RULE_TWO, 200, SECOND_CLIENT),
        ],
        expectedState(null, RULE_TWO),
      );

      await expectConvergence(
        encoding,
        [
          ruleMessage(encoding, RULE_TWO, 200, SECOND_CLIENT),
          ruleMessage(encoding, null, 300, RESET_CLIENT),
        ],
        expectedState(null, null),
      );
    });

    it('converges to Default after a non-atomic reset of both cells', async () => {
      const initial = [
        ruleMessage(encoding, RULE_ONE, 100),
        manualMessage(encoding, 202411, 110),
      ];
      const clearManual = manualMessage(encoding, null, 200, RESET_CLIENT);
      const clearRule = ruleMessage(encoding, null, 210, RESET_CLIENT);

      await expectConvergence(
        encoding,
        [...initial, clearManual, clearRule],
        expectedState(null, null),
      );

      await resetProbeDatabase();
      await applyMessages(initial);
      await applyMessages([clearManual]);
      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(null, RULE_ONE),
      );
      await applyMessages([clearRule]);
      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(null, null),
      );

      await resetProbeDatabase();
      await applyMessages(initial);
      await applyMessages([clearRule]);
      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(202411, null),
      );
      await applyMessages([clearManual]);
      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(null, null),
      );
    });

    it('makes the same-cell LWW winner explicit for reset versus new Manual', async () => {
      await expectConvergence(
        encoding,
        [
          ruleMessage(encoding, RULE_ONE, 100),
          manualMessage(encoding, null, 200, RESET_CLIENT),
          ruleMessage(encoding, null, 210, RESET_CLIENT),
          manualMessage(encoding, 202412, 300, SECOND_CLIENT),
        ],
        expectedState(202412, null),
      );

      await expectConvergence(
        encoding,
        [
          ruleMessage(encoding, RULE_ONE, 100),
          manualMessage(encoding, 202412, 200, SECOND_CLIENT),
          manualMessage(encoding, null, 300, RESET_CLIENT),
          ruleMessage(encoding, null, 310, RESET_CLIENT),
        ],
        expectedState(null, null),
      );
    });

    it('makes the same-cell LWW winner explicit for reset versus new Rule', async () => {
      await expectConvergence(
        encoding,
        [
          manualMessage(encoding, 202411, 100),
          manualMessage(encoding, null, 200, RESET_CLIENT),
          ruleMessage(encoding, null, 210, RESET_CLIENT),
          ruleMessage(encoding, RULE_TWO, 300, SECOND_CLIENT),
        ],
        expectedState(null, RULE_TWO),
      );

      await expectConvergence(
        encoding,
        [
          manualMessage(encoding, 202411, 100),
          ruleMessage(encoding, RULE_TWO, 200, SECOND_CLIENT),
          manualMessage(encoding, null, 300, RESET_CLIENT),
          ruleMessage(encoding, null, 310, RESET_CLIENT),
        ],
        expectedState(null, null),
      );
    });

    it('keeps the produced snapshot when its Rule is disabled and deleted', async () => {
      await applyMessages([
        ruleMessage(encoding, RULE_ONE, 100),
        externalRuleMessage('active', 0, 200),
        externalRuleMessage('tombstone', 1, 210),
      ]);

      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(null, RULE_ONE),
      );
      expect(
        await db.first<{ active: number; tombstone: number }>(
          `SELECT active, tombstone FROM ${RULE_DATASET} WHERE id = ?`,
          [RULE_ONE.ruleId],
        ),
      ).toEqual({ active: 0, tombstone: 1 });
    });

    it('exercises compareMessages through stale delivery and idempotent replay', async () => {
      const olderRule = ruleMessage(encoding, RULE_ONE, 100);
      const newerRule = ruleMessage(encoding, RULE_TWO, 200, SECOND_CLIENT);

      expect(await applyMessages([newerRule])).toEqual([newerRule]);
      expect(await applyMessages([olderRule])).toEqual([
        { ...olderRule, old: true },
      ]);
      expect(await applyMessages([newerRule])).toEqual([]);

      expect(await readEffectiveState(encoding)).toEqual(
        expectedState(null, RULE_TWO),
      );
      expect(await readPersistedMessages(encoding)).toHaveLength(2);
    });

    it.each(['split', 'transfer'])(
      'only exposes the multi-row risk for a %s',
      async kind => {
        const firstRow = `${kind}-line-1`;
        const secondRow = `${kind}-line-2`;
        const initial = [
          ruleMessage(encoding, RULE_ONE, 100, RULE_CLIENT, firstRow),
          ruleMessage(encoding, RULE_ONE, 110, RULE_CLIENT, secondRow),
        ];
        const manual = [
          manualMessage(encoding, 202411, 200, MANUAL_CLIENT, firstRow),
          manualMessage(encoding, 202411, 210, MANUAL_CLIENT, secondRow),
        ];

        await applyMessages(initial);
        await applyMessages([manual[0]]);
        expect(await readEffectiveState(encoding, firstRow)).toEqual(
          expectedState(202411, RULE_ONE),
        );
        expect(await readEffectiveState(encoding, secondRow)).toEqual(
          expectedState(null, RULE_ONE),
        );

        await applyMessages([manual[1]]);
        expect(await readEffectiveState(encoding, firstRow)).toEqual(
          await readEffectiveState(encoding, secondRow),
        );
      },
    );
  });

  describe('representation validation', () => {
    it('serializes JSON deterministically and accepts only the exact canonical shape', () => {
      expect(encodeCanonicalJson({ ruleId: 'rule-1', period: '2024-10' })).toBe(
        '{"period":"2024-10","ruleId":"rule-1"}',
      );
      expect(decodeCanonicalJson(encodeCanonicalJson(RULE_TWO))).toEqual(
        RULE_TWO,
      );

      expect(() =>
        decodeCanonicalJson(
          '{"period":"2024-10","ruleId":"rule-1","extra":true}',
        ),
      ).toThrow('exactly period and ruleId');
      expect(() =>
        decodeCanonicalJson('{"period":"2024-13","ruleId":"rule-1"}'),
      ).toThrow('period must use YYYY-MM');
      expect(() =>
        decodeCanonicalJson('{"period":"2024-10","ruleId":""}'),
      ).toThrow('ruleId must be a non-empty string');
      expect(() =>
        decodeCanonicalJson('{"ruleId":"rule-1","period":"2024-10"}'),
      ).toThrow('canonical encoding');
    });

    it('round-trips delimiter-bearing Rule ids with canonical text', () => {
      expect(encodeCanonicalText(RULE_TWO)).toBe(
        '202412|rule%2F2%7Creplacement',
      );
      expect(decodeCanonicalText(encodeCanonicalText(RULE_TWO))).toEqual(
        RULE_TWO,
      );
      expect(() => decodeCanonicalText('202413|rule-1')).toThrow(
        'period must use YYYY-MM',
      );
      expect(() => decodeCanonicalText('202410|')).toThrow(
        'ruleId must be a non-empty string',
      );
    });

    it('demonstrates that the native AQL json converter does not validate the business shape', () => {
      const malformed = {
        period: '2024-13',
        ruleId: '',
        extra: true,
      };
      const converted: Record<string, unknown> = convertForUpdate(
        schemaFor(ENCODINGS[0]),
        schemaConfigFor(ENCODINGS[0]),
        JSON_DATASET,
        { id: ROW_ID, rule_assignment: malformed },
      );

      expect(converted.rule_assignment).toBe(JSON.stringify(malformed));
      expect(() =>
        decodeCanonicalJson(String(converted.rule_assignment)),
      ).toThrow('exactly period and ruleId');
    });

    it('uses the existing SQLite JSON1 functions for storage inspection', async () => {
      const encoded = encodeCanonicalJson(RULE_TWO);
      const result = await db.first<{
        is_valid: number;
        period: string;
        rule_id: string;
      }>(
        `SELECT
           json_valid(?) AS is_valid,
           json_extract(?, '$.period') AS period,
           json_extract(?, '$.ruleId') AS rule_id`,
        [encoded, encoded, encoded],
      );
      const keys = await db.all<{ key: string }>(
        'SELECT key FROM json_each(?) ORDER BY key',
        [encoded],
      );

      expect(result).toEqual({
        is_valid: 1,
        period: RULE_TWO.period,
        rule_id: RULE_TWO.ruleId,
      });
      expect(keys.map(item => item.key)).toEqual(['period', 'ruleId']);
    });
  });

  describe.each(ENCODINGS)('$name SQLite and AQL feasibility', encoding => {
    it('writes through AQL conversion and reads, filters, sorts and aggregates the effective period', async () => {
      await writeThroughAqlConversion(encoding, {
        id: 'default-september',
        date: '2024-09-15',
        amount: 100,
      });
      await writeThroughAqlConversion(encoding, {
        id: 'rule-october',
        date: '2024-09-16',
        amount: 200,
        rule_assignment: RULE_ONE,
      });
      await writeThroughAqlConversion(encoding, {
        id: 'manual-november',
        date: '2024-09-17',
        amount: 300,
        manual_budget_period: '2024-11',
        rule_assignment: RULE_ONE,
      });
      await writeThroughAqlConversion(encoding, {
        id: 'rule-november',
        date: '2024-09-18',
        amount: 400,
        rule_assignment: { period: '2024-11', ruleId: 'rule-3' },
      });

      const manual = await runAql(
        encoding,
        q(encoding.dataset)
          .filter({ id: 'manual-november' })
          .select([
            'date',
            'manual_budget_period',
            'rule_assignment',
            'derived_source',
            'effective_budget_period',
          ])
          .serialize(),
      );
      expect(manual.data).toEqual([
        {
          id: 'manual-november',
          date: '2024-09-17',
          manual_budget_period: '2024-11',
          rule_assignment: logicalRuleAssignment(encoding, RULE_ONE),
          derived_source: 'manual',
          effective_budget_period: '2024-11',
        },
      ]);

      const filtered = await runAql(
        encoding,
        q(encoding.dataset)
          .filter({ effective_budget_period: '2024-11' })
          .select(['effective_budget_period', 'amount'])
          .orderBy({ amount: 'desc' })
          .serialize(),
      );
      expect(
        filtered.data.map((row: Record<string, unknown>) => row.id),
      ).toEqual(['rule-november', 'manual-november']);

      const sorted = await runAql(
        encoding,
        q(encoding.dataset)
          .select('effective_budget_period')
          .orderBy('effective_budget_period')
          .serialize(),
      );
      expect(
        sorted.data.map(
          (row: Record<string, unknown>) => row.effective_budget_period,
        ),
      ).toEqual(['2024-09', '2024-10', '2024-11', '2024-11']);

      const grouped = await runAql(
        encoding,
        q(encoding.dataset)
          .select(['effective_budget_period', { total: { $sum: '$amount' } }])
          .groupBy('effective_budget_period')
          .orderBy('effective_budget_period')
          .serialize(),
      );
      expect(grouped.data).toEqual([
        { effective_budget_period: '2024-09', total: 100 },
        { effective_budget_period: '2024-10', total: 200 },
        { effective_budget_period: '2024-11', total: 700 },
      ]);
    });

    it('only proves that SQLite can use an exact expression index', async () => {
      await writeThroughAqlConversion(encoding, {
        id: 'indexed-row',
        date: '2024-09-15',
        amount: 100,
        rule_assignment: { period: '2024-11', ruleId: 'rule-index' },
      });
      const expression = effectivePeriodSql(encoding.rulePeriodSql);
      const indexName = `${encoding.dataset}_effective_idx`;
      const query = `SELECT id FROM ${encoding.dataset} WHERE ${expression} = 202411`;

      const before = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
      );
      db.execQuery(
        `CREATE INDEX ${indexName} ON ${encoding.dataset} (${expression})`,
      );
      const after = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
      );

      expect(before.some(row => row.detail.includes(indexName))).toBe(false);
      expect(after.some(row => row.detail.includes(indexName))).toBe(true);
    });
  });
});
