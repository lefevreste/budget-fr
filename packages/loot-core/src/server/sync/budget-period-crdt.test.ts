import { Timestamp } from '@actual-app/crdt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import * as prefs from '#server/prefs';
import * as mockSyncServer from '#server/tests/mockSyncServer';

import {
  applyMessages,
  batchMessages,
  sendMessages,
  setSyncingMode,
} from './index';
import type { Message } from './index';

const DATASET = 'budget_period_crdt_probe';
const ROW_ID = 'transaction-1';
const BASE_TIME = Date.parse('2020-01-01T00:00:00.000Z');
const RULE_CLIENT = 'RULE000000000001';
const MANUAL_CLIENT = 'MANUAL0000000001';
const REPAIR_CLIENT = 'REPAIR0000000001';

type BudgetPeriodSource = 'rule' | 'manual' | null;

type Assignment = {
  period: number | null;
  source: BudgetPeriodSource;
  ruleId: string | null;
};

type ProbeRow = {
  id: string;
  budget_period: number | null;
  budget_period_source: BudgetPeriodSource;
  budget_period_rule_id: string | null;
  budget_period_assignment: string | null;
};

type AssignmentState = 'default' | 'rule' | 'manual' | 'invalid';

const RULE_ASSIGNMENT: Assignment = {
  period: 202410,
  source: 'rule',
  ruleId: 'rule-1',
};

const MANUAL_ASSIGNMENT: Assignment = {
  period: 202411,
  source: 'manual',
  ruleId: null,
};

const DEFAULT_ASSIGNMENT: Assignment = {
  period: null,
  source: null,
  ruleId: null,
};

beforeEach(async () => {
  setSyncingMode('enabled');
  await resetProbeDatabase();
});

afterEach(() => {
  setSyncingMode('disabled');
});

async function resetProbeDatabase(): Promise<void> {
  mockSyncServer.reset();
  await global.emptyDatabase()();
  void prefs.loadPrefs();
  void prefs.savePrefs({
    groupId: 'budget-period-crdt-spike',
    lastSyncedTimestamp: Timestamp.zero.toString(),
  });

  db.execQuery(`
    CREATE TABLE ${DATASET} (
      id TEXT PRIMARY KEY,
      budget_period INTEGER,
      budget_period_source TEXT,
      budget_period_rule_id TEXT,
      budget_period_assignment TEXT,
      rejected_value TEXT CHECK (rejected_value IS NULL)
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

function rejectedMessage(): Message {
  return {
    dataset: DATASET,
    row: ROW_ID,
    column: 'rejected_value',
    value: 'must-roll-back',
    timestamp: nextHulc(),
  };
}

function assignmentMessages(
  assignment: Assignment,
  node: string,
  offsets: readonly [number, number, number],
): Message[] {
  return [
    {
      dataset: DATASET,
      row: ROW_ID,
      column: 'budget_period',
      value: assignment.period,
      timestamp: hulc(offsets[0], node),
    },
    {
      dataset: DATASET,
      row: ROW_ID,
      column: 'budget_period_source',
      value: assignment.source,
      timestamp: hulc(offsets[1], node),
    },
    {
      dataset: DATASET,
      row: ROW_ID,
      column: 'budget_period_rule_id',
      value: assignment.ruleId,
      timestamp: hulc(offsets[2], node),
    },
  ];
}

function compositeMessage(
  assignment: Assignment,
  node: string,
  offset: number,
): Message {
  return {
    dataset: DATASET,
    row: ROW_ID,
    column: 'budget_period_assignment',
    value: JSON.stringify(assignment),
    timestamp: hulc(offset, node),
  };
}

async function readProbeRow(): Promise<ProbeRow | null> {
  return db.first<ProbeRow>(`SELECT * FROM ${DATASET} WHERE id = ?`, [ROW_ID]);
}

async function readAssignment(): Promise<Assignment> {
  const row = await readProbeRow();
  return {
    period: row?.budget_period ?? null,
    source: row?.budget_period_source ?? null,
    ruleId: row?.budget_period_rule_id ?? null,
  };
}

async function readPersistedMessages(): Promise<db.DbCrdtMessage[]> {
  return db.all<db.DbCrdtMessage>(
    `SELECT * FROM messages_crdt
     WHERE dataset = ? AND row = ?
     ORDER BY timestamp`,
    [DATASET, ROW_ID],
  );
}

async function applyDelivery(
  chunks: readonly Message[][],
): Promise<Assignment> {
  await resetProbeDatabase();
  for (const chunk of chunks) {
    await applyMessages(chunk);
  }
  return readAssignment();
}

function classifyAssignment(assignment: Assignment): AssignmentState {
  if (
    assignment.period === null &&
    assignment.source === null &&
    assignment.ruleId === null
  ) {
    return 'default';
  }

  if (
    assignment.period !== null &&
    assignment.source === 'rule' &&
    assignment.ruleId !== null
  ) {
    return 'rule';
  }

  if (
    assignment.period !== null &&
    assignment.source === 'manual' &&
    assignment.ruleId === null
  ) {
    return 'manual';
  }

  return 'invalid';
}

async function repairInvalidAssignment(
  offsets: readonly [number, number, number],
): Promise<Message[]> {
  if (classifyAssignment(await readAssignment()) !== 'invalid') {
    return [];
  }

  const repairMessages = assignmentMessages(
    DEFAULT_ASSIGNMENT,
    REPAIR_CLIENT,
    offsets,
  );
  await applyMessages(repairMessages);
  return repairMessages;
}

describe('Budget period CRDT spike', () => {
  describe('batchMessages and local SQLite atomicity', () => {
    it('persists and sends one independent HULC message per tuple column', async () => {
      await batchMessages(async () => {
        await db.update(DATASET, {
          id: ROW_ID,
          budget_period: RULE_ASSIGNMENT.period,
          budget_period_source: RULE_ASSIGNMENT.source,
          budget_period_rule_id: RULE_ASSIGNMENT.ruleId,
        });
      });

      const persisted = await readPersistedMessages();
      const sent = mockSyncServer
        .getMessages()
        .filter(
          message => message.dataset === DATASET && message.row === ROW_ID,
        );

      expect(persisted).toHaveLength(3);
      expect(sent).toHaveLength(3);
      expect(new Set(persisted.map(message => message.timestamp)).size).toBe(3);
      expect(sent.map(message => message.column)).toEqual([
        'budget_period',
        'budget_period_source',
        'budget_period_rule_id',
      ]);

      const timestamps = sent.map(message => message.timestamp);
      expect(timestamps[0].toString() < timestamps[1].toString()).toBe(true);
      expect(timestamps[1].toString() < timestamps[2].toString()).toBe(true);
      expect(new Set(timestamps.map(timestamp => timestamp.node())).size).toBe(
        1,
      );
    });

    it('groups distinct emissions so a late failure rolls back only when batched', async () => {
      await db.update(DATASET, {
        id: ROW_ID,
        budget_period: RULE_ASSIGNMENT.period,
      });

      expect((await readProbeRow())?.budget_period).toBe(
        RULE_ASSIGNMENT.period,
      );
      expect(
        (await readPersistedMessages()).map(message => message.column),
      ).toEqual(['budget_period']);
      expect(
        mockSyncServer
          .getMessages()
          .filter(
            message => message.dataset === DATASET && message.row === ROW_ID,
          )
          .map(message => message.column),
      ).toEqual(['budget_period']);

      await expect(sendMessages([rejectedMessage()])).rejects.toThrow();

      expect((await readProbeRow())?.budget_period).toBe(
        RULE_ASSIGNMENT.period,
      );
      expect(
        (await readPersistedMessages()).map(message => message.column),
      ).toEqual(['budget_period']);
      expect(
        mockSyncServer
          .getMessages()
          .filter(
            message => message.dataset === DATASET && message.row === ROW_ID,
          )
          .map(message => message.column),
      ).toEqual(['budget_period']);

      await resetProbeDatabase();

      await expect(
        batchMessages(async () => {
          await db.update(DATASET, {
            id: ROW_ID,
            budget_period: RULE_ASSIGNMENT.period,
          });
          await sendMessages([rejectedMessage()]);
        }),
      ).rejects.toThrow();

      expect(await readProbeRow()).toBeNull();
      expect(await readPersistedMessages()).toEqual([]);
      expect(
        mockSyncServer
          .getMessages()
          .filter(
            message => message.dataset === DATASET && message.row === ROW_ID,
          ),
      ).toEqual([]);
    });
  });

  describe('option A: three independently resolved columns', () => {
    it('preserves the expected Rule and Manual control states', async () => {
      const rule = assignmentMessages(
        RULE_ASSIGNMENT,
        RULE_CLIENT,
        [100, 101, 102],
      );
      const manual = assignmentMessages(
        MANUAL_ASSIGNMENT,
        MANUAL_CLIENT,
        [200, 201, 202],
      );

      expect(await applyDelivery([rule])).toEqual(RULE_ASSIGNMENT);
      expect(await applyDelivery([manual])).toEqual(MANUAL_ASSIGNMENT);
      expect(await applyDelivery([rule, manual])).toEqual(MANUAL_ASSIGNMENT);
    });

    it.each([
      {
        name: 'Manual source with a Rule id',
        ruleOffsets: [200, 202, 206] as const,
        manualOffsets: [199, 204, 205] as const,
        expected: {
          period: RULE_ASSIGNMENT.period,
          source: MANUAL_ASSIGNMENT.source,
          ruleId: RULE_ASSIGNMENT.ruleId,
        } satisfies Assignment,
        state: 'invalid' as const,
      },
      {
        name: 'Rule source without a Rule id',
        ruleOffsets: [199, 204, 205] as const,
        manualOffsets: [200, 203, 206] as const,
        expected: {
          period: MANUAL_ASSIGNMENT.period,
          source: RULE_ASSIGNMENT.source,
          ruleId: MANUAL_ASSIGNMENT.ruleId,
        } satisfies Assignment,
        state: 'invalid' as const,
      },
      {
        name: 'valid-looking Rule tuple with the Manual period',
        ruleOffsets: [199, 204, 206] as const,
        manualOffsets: [200, 203, 205] as const,
        expected: {
          period: MANUAL_ASSIGNMENT.period,
          source: RULE_ASSIGNMENT.source,
          ruleId: RULE_ASSIGNMENT.ruleId,
        } satisfies Assignment,
        state: 'rule' as const,
      },
    ])('converges to $name for every delivery plan', async scenario => {
      const rule = assignmentMessages(
        RULE_ASSIGNMENT,
        RULE_CLIENT,
        scenario.ruleOffsets,
      );
      const manual = assignmentMessages(
        MANUAL_ASSIGNMENT,
        MANUAL_CLIENT,
        scenario.manualOffsets,
      );
      const all = [...rule, ...manual];
      const deliveryPlans: Message[][][] = [
        [all],
        [rule, manual],
        [manual, rule],
        [
          [manual[0]],
          [rule[0]],
          [rule[1]],
          [manual[1]],
          [manual[2]],
          [rule[2]],
        ],
        [
          [rule[0], manual[0]],
          [manual[1], rule[1]],
          [rule[2], manual[2]],
        ],
      ];

      for (const deliveryPlan of deliveryPlans) {
        const result = await applyDelivery(deliveryPlan);
        expect(result).toEqual(scenario.expected);
        expect(classifyAssignment(result)).toBe(scenario.state);
        expect(await readPersistedMessages()).toHaveLength(6);
      }
    });
  });

  describe('option B: one composite column', () => {
    it('keeps each assignment intact but still follows column LWW', async () => {
      const manual = compositeMessage(MANUAL_ASSIGNMENT, MANUAL_CLIENT, 300);
      const newerRule = compositeMessage(RULE_ASSIGNMENT, RULE_CLIENT, 301);

      await applyMessages([manual, newerRule]);
      let row = await readProbeRow();
      expect(row?.budget_period_assignment).toBe(
        JSON.stringify(RULE_ASSIGNMENT),
      );

      await resetProbeDatabase();
      const rule = compositeMessage(RULE_ASSIGNMENT, RULE_CLIENT, 400);
      const newerManual = compositeMessage(
        MANUAL_ASSIGNMENT,
        MANUAL_CLIENT,
        401,
      );
      await applyMessages([newerManual]);
      await applyMessages([rule]);

      row = await readProbeRow();
      expect(row?.budget_period_assignment).toBe(
        JSON.stringify(MANUAL_ASSIGNMENT),
      );
      expect(await readPersistedMessages()).toHaveLength(2);
    });
  });

  describe('option C: shape validation and deterministic repair', () => {
    it('repairs a fully converged invalid tuple to Default idempotently', async () => {
      const rule = assignmentMessages(
        RULE_ASSIGNMENT,
        RULE_CLIENT,
        [200, 202, 206],
      );
      const manual = assignmentMessages(
        MANUAL_ASSIGNMENT,
        MANUAL_CLIENT,
        [199, 204, 205],
      );
      await applyMessages([...rule, ...manual]);
      expect(classifyAssignment(await readAssignment())).toBe('invalid');

      const repair = await repairInvalidAssignment([300, 301, 302]);
      expect(repair).toHaveLength(3);
      expect(await readAssignment()).toEqual(DEFAULT_ASSIGNMENT);
      expect(classifyAssignment(await readAssignment())).toBe('default');
      expect(await repairInvalidAssignment([400, 401, 402])).toEqual([]);

      await resetProbeDatabase();
      await applyMessages(repair);
      await applyMessages([...manual, ...rule]);
      expect(await readAssignment()).toEqual(DEFAULT_ASSIGNMENT);
      expect(await readPersistedMessages()).toHaveLength(9);
    });

    it('can erase a Manual assignment when it repairs a partial delivery', async () => {
      const manual = assignmentMessages(
        MANUAL_ASSIGNMENT,
        MANUAL_CLIENT,
        [200, 203, 206],
      );

      await applyMessages([manual[0]]);
      expect(classifyAssignment(await readAssignment())).toBe('invalid');
      expect(await repairInvalidAssignment([300, 301, 302])).toHaveLength(3);
      await applyMessages(manual.slice(1));

      expect(await readAssignment()).toEqual(DEFAULT_ASSIGNMENT);
      expect(classifyAssignment(await readAssignment())).toBe('default');
    });

    it('cannot detect a semantically mixed tuple with a valid Rule shape', async () => {
      const rule = assignmentMessages(
        RULE_ASSIGNMENT,
        RULE_CLIENT,
        [199, 204, 206],
      );
      const manual = assignmentMessages(
        MANUAL_ASSIGNMENT,
        MANUAL_CLIENT,
        [200, 203, 205],
      );
      await applyMessages([...rule, ...manual]);

      expect(await readAssignment()).toEqual({
        period: MANUAL_ASSIGNMENT.period,
        source: RULE_ASSIGNMENT.source,
        ruleId: RULE_ASSIGNMENT.ruleId,
      });
      expect(classifyAssignment(await readAssignment())).toBe('rule');
      expect(await repairInvalidAssignment([300, 301, 302])).toEqual([]);
    });
  });
});
