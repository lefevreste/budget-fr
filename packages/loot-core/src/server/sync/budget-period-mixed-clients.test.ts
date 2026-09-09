import {
  fromBinary,
  getClock,
  makeClock,
  serializeClock,
  setClock,
  SyncRequestSchema,
  Timestamp,
} from '@actual-app/crdt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as sqlite from '#platform/server/sqlite';
import * as db from '#server/db';
import * as prefs from '#server/prefs';
import * as mockSyncServer from '#server/tests/mockSyncServer';
import { getSyncError } from '#shared/errors';
import type { MetadataPrefs } from '#types/prefs';

import {
  fullSync,
  receiveMessages,
  sendMessages,
  setSyncingMode,
} from './index';
import type { Message } from './index';

const DATASET = 'budget_period_mixed_clients_probe';
const GROUP_ID = 'budget-period-mixed-clients';
const CLOUD_FILE_ID = 'budget-period-mixed-clients-file';
const ROW_ID = 'transaction-1';
const BASE_TIME = Date.now();
const CANONICAL_RULE = '{"period":"2024-10","ruleId":"rule-1"}';
const INVALID_RULE_SENTINEL = 'SYNTHETIC_INVALID_RULE_SENTINEL_{';
const SCHEMA_MISMATCH_TEXT =
  'This budget could not be loaded because it uses a newer database schema than this version of Actual supports. Make sure you are using the latest version, then try again.';

type SchemaKind = 'legacy' | 'budget-fr';
type ClientDatabase = NonNullable<ReturnType<typeof db.getDatabase>>;
type ClientClock = ReturnType<typeof getClock>;

type LogicalClient = {
  name: string;
  schema: SchemaKind;
  database: ClientDatabase;
  clock: ClientClock;
  preferences: MetadataPrefs;
};

type ProbeRow = {
  id: string;
  known_value: number | null;
  manual_budget_period?: number | null;
  rule_assignment?: string | null;
};

type PersistedMessage = {
  timestamp: string;
  dataset: string;
  row: string;
  column: string;
  value: string;
};

type PersistedClock = {
  id: string;
  clock: string;
};

type PersistentSnapshot = {
  rows: ProbeRow[];
  messages: PersistedMessage[];
  clocks: PersistedClock[];
  merkle: string;
  lastSyncedTimestamp: string | null;
};

type ClientSnapshot = PersistentSnapshot & {
  hulc: string;
};

type FullSyncResult = NonNullable<Awaited<ReturnType<typeof fullSync>>>;
type FullSyncError = Extract<FullSyncResult, { error: unknown }>['error'];
type SqlValue = string | number | null;
type SqlMeta = {
  error: {
    message: string;
    stack: string;
  };
  query: {
    sql: string;
    params: SqlValue[];
  };
};

const testGlobal = globalThis as typeof globalThis & {
  resetTime: () => void;
  restoreFakeDateNow: () => void;
};

let activeClient: LogicalClient | null = null;
let clients: LogicalClient[] = [];

beforeEach(() => {
  mockSyncServer.reset();
  setSyncingMode('enabled');
  activeClient = null;
  clients = [];
});

afterEach(() => {
  setSyncingMode('disabled');
  prefs.unloadPrefs();
  mockSyncServer.reset();
  for (const client of clients) {
    if (client !== activeClient) {
      sqlite.closeDatabase(client.database);
    }
  }
  if (activeClient !== null) {
    db.closeDatabase();
  }
  testGlobal.resetTime();
  testGlobal.restoreFakeDateNow();
  Timestamp.init();
  activeClient = null;
  clients = [];
});

async function createClient(
  name: string,
  schema: SchemaKind,
  node: string,
): Promise<LogicalClient> {
  saveActivePreferences();
  await global.emptyDatabase()();

  const database = db.getDatabase();
  if (database === null) {
    throw new Error('The in-memory client database was not created');
  }

  db.execQuery(
    schema === 'legacy'
      ? `CREATE TABLE ${DATASET} (
           id TEXT PRIMARY KEY,
           known_value INTEGER
         )`
      : `CREATE TABLE ${DATASET} (
           id TEXT PRIMARY KEY,
           known_value INTEGER,
           manual_budget_period INTEGER,
           rule_assignment TEXT
         )`,
  );

  const clock = makeClock(new Timestamp(BASE_TIME, 0, node));
  setClock(clock);
  db.runQuery(
    'INSERT OR REPLACE INTO messages_clock (id, clock) VALUES (1, ?)',
    [serializeClock(clock)],
  );

  await prefs.loadPrefs();
  await prefs.savePrefs(
    {
      id: name,
      budgetName: name,
      cloudFileId: CLOUD_FILE_ID,
      groupId: GROUP_ID,
      lastSyncedTimestamp: Timestamp.zero.toString(),
    },
    { avoidSync: true },
  );

  const client: LogicalClient = {
    name,
    schema,
    database,
    clock,
    preferences: { ...prefs.getPrefs() },
  };
  activeClient = client;
  clients.push(client);
  return client;
}

function saveActivePreferences(): void {
  if (activeClient !== null) {
    activeClient.preferences = { ...prefs.getPrefs() };
  }
}

async function activateClient(client: LogicalClient): Promise<void> {
  saveActivePreferences();
  db.setDatabase(client.database);
  setClock(client.clock);
  prefs.unloadPrefs();
  await prefs.loadPrefs();
  await prefs.savePrefs(client.preferences, { avoidSync: true });
  activeClient = client;
}

async function stageUpdate(
  client: LogicalClient,
  values: Record<string, string | number | null>,
  id = ROW_ID,
): Promise<void> {
  await activateClient(client);
  setSyncingMode('offline');
  try {
    await db.update(DATASET, { id, ...values });
  } finally {
    setSyncingMode('enabled');
  }
  saveActivePreferences();
}

async function stageMessages(
  client: LogicalClient,
  messages: Message[],
): Promise<void> {
  await activateClient(client);
  setSyncingMode('offline');
  try {
    await sendMessages(messages);
  } finally {
    setSyncingMode('enabled');
  }
  saveActivePreferences();
}

async function syncClient(client: LogicalClient): Promise<FullSyncResult> {
  await activateClient(client);
  setSyncingMode('enabled');
  expect(prefs.getPrefs()).toMatchObject({
    cloudFileId: CLOUD_FILE_ID,
    groupId: GROUP_ID,
  });

  const handlers = mockSyncServer.handlers;
  if (!isRecord(handlers)) {
    throw new Error('Expected the mock server handlers registry');
  }
  const originalSyncHandler = handlers['/sync/sync'];
  if (typeof originalSyncHandler !== 'function') {
    throw new Error('Expected the mock server sync handler');
  }

  const observedRemoteIdentities: Array<{
    fileId: string;
    groupId: string;
  }> = [];
  handlers['/sync/sync'] = async (data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      throw new Error('Expected a binary sync request');
    }
    const request = fromBinary(SyncRequestSchema, data);
    observedRemoteIdentities.push({
      fileId: request.fileId,
      groupId: request.groupId,
    });
    return Reflect.apply(originalSyncHandler, undefined, [data]);
  };

  try {
    const result = await fullSync();
    expect(observedRemoteIdentities.length).toBeGreaterThan(0);
    for (const identity of observedRemoteIdentities) {
      expect(identity).toEqual({
        fileId: CLOUD_FILE_ID,
        groupId: GROUP_ID,
      });
    }
    if (result === null) {
      throw new Error('Expected fullSync to return a result');
    }
    saveActivePreferences();
    return result;
  } finally {
    handlers['/sync/sync'] = originalSyncHandler;
  }
}

function expectSuccessfulSync(result: FullSyncResult): Message[] {
  if ('error' in result) {
    throw new Error(
      `Expected successful sync, received ${result.error.reason}`,
    );
  }
  return result.messages;
}

function expectInvalidSchema(result: FullSyncResult): FullSyncError {
  expect(result).toHaveProperty('error.reason', 'invalid-schema');
  if (!('error' in result)) {
    throw new Error('Expected fullSync to return invalid-schema');
  }
  expect(result.error.message).toBe('SyncError: invalid-schema');
  return result.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null || typeof value === 'string' || typeof value === 'number'
  );
}

function isSqlMeta(value: unknown): value is SqlMeta {
  if (
    !isRecord(value) ||
    !isRecord(value.error) ||
    typeof value.error.message !== 'string' ||
    typeof value.error.stack !== 'string' ||
    !isRecord(value.query) ||
    typeof value.query.sql !== 'string' ||
    !Array.isArray(value.query.params) ||
    !value.query.params.every(isSqlValue)
  ) {
    return false;
  }
  return true;
}

function requireSqlMeta(error: FullSyncError): SqlMeta {
  if (!isSqlMeta(error.meta)) {
    throw new Error('Expected complete SQL metadata on invalid-schema');
  }
  return error.meta;
}

async function snapshot(client: LogicalClient): Promise<ClientSnapshot> {
  await activateClient(client);
  const rows = await db.all<ProbeRow>(`SELECT * FROM ${DATASET} ORDER BY id`);
  const messages = await db.all<PersistedMessage>(
    `SELECT timestamp, dataset, row, column, value
       FROM messages_crdt
      ORDER BY timestamp, dataset, row, column`,
  );
  const clocks = await db.all<PersistedClock>(
    'SELECT id, clock FROM messages_clock ORDER BY id',
  );
  return {
    rows,
    messages,
    clocks,
    merkle: JSON.stringify(getClock().merkle),
    lastSyncedTimestamp: prefs.getPrefs()?.lastSyncedTimestamp ?? null,
    hulc: getClock().timestamp.toString(),
  };
}

function persistentPart(snapshotValue: ClientSnapshot): PersistentSnapshot {
  const { hulc: _hulc, ...persistent } = snapshotValue;
  return persistent;
}

function serverMessagesForRow(id = ROW_ID): Message[] {
  return mockSyncServer
    .getMessages()
    .filter(message => message.dataset === DATASET && message.row === id);
}

async function readRow(
  client: LogicalClient,
  id = ROW_ID,
): Promise<ProbeRow | null> {
  await activateClient(client);
  return db.first<ProbeRow>(`SELECT * FROM ${DATASET} WHERE id = ?`, [id]);
}

async function addBudgetColumns(client: LogicalClient): Promise<void> {
  await activateClient(client);
  db.execQuery(
    `ALTER TABLE ${DATASET} ADD COLUMN manual_budget_period INTEGER`,
  );
  db.execQuery(`ALTER TABLE ${DATASET} ADD COLUMN rule_assignment TEXT`);
  client.schema = 'budget-fr';
}

function message(
  clientNode: string,
  column: string,
  value: string | number | null,
  offset: number,
  id = ROW_ID,
): Message {
  return {
    dataset: DATASET,
    row: id,
    column,
    value,
    timestamp: new Timestamp(BASE_TIME + offset, 0, clientNode),
  };
}

async function establishExistingRow(
  legacy: LogicalClient,
  budgetClient: LogicalClient,
): Promise<void> {
  await stageUpdate(legacy, { known_value: 10 });
  expectSuccessfulSync(await syncClient(legacy));
  expectSuccessfulSync(await syncClient(budgetClient));
}

describe('mixed-client controls', () => {
  it('M01 synchronizes a known column from legacy to legacy', async () => {
    const writer = await createClient(
      'legacy-writer',
      'legacy',
      'LEGACY0000000001',
    );
    const reader = await createClient(
      'legacy-reader',
      'legacy',
      'LEGACY0000000002',
    );

    await stageUpdate(writer, { known_value: 42 });
    expectSuccessfulSync(await syncClient(writer));
    expectSuccessfulSync(await syncClient(reader));

    expect(await readRow(reader)).toEqual({ id: ROW_ID, known_value: 42 });
  });

  it('M02 synchronizes Manual and canonical Rule from new to new', async () => {
    const writer = await createClient(
      'new-writer',
      'budget-fr',
      'BUDGETFR00000001',
    );
    const reader = await createClient(
      'new-reader',
      'budget-fr',
      'BUDGETFR00000002',
    );

    await stageUpdate(writer, {
      known_value: 7,
      manual_budget_period: 202411,
    });
    await stageMessages(writer, [
      message('BUDGETFR00000001', 'rule_assignment', CANONICAL_RULE, 1000),
    ]);
    expectSuccessfulSync(await syncClient(writer));
    expectSuccessfulSync(await syncClient(reader));

    expect(await readRow(reader)).toEqual({
      id: ROW_ID,
      known_value: 7,
      manual_budget_period: 202411,
      rule_assignment: CANONICAL_RULE,
    });
  });
});

describe('unknown Budget FR columns on a legacy client', () => {
  it('M03 rolls back an UPDATE failure while the in-memory HULC advances', async () => {
    const legacy = await createClient(
      'legacy-update',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-update',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await establishExistingRow(legacy, budgetClient);
    await stageUpdate(budgetClient, { manual_budget_period: 202411 });
    expectSuccessfulSync(await syncClient(budgetClient));

    const before = await snapshot(legacy);
    const error = expectInvalidSchema(await syncClient(legacy));
    const after = await snapshot(legacy);
    const meta = requireSqlMeta(error);

    expect(persistentPart(after)).toEqual(persistentPart(before));
    expect(after.hulc > before.hulc).toBe(true);
    expect(meta.query.sql).toContain('UPDATE');
    expect(meta.error.message).toBe('no such column: manual_budget_period');
    expect(getSyncError(error.reason, legacy.name, error.meta)).toBe(
      SCHEMA_MISMATCH_TEXT,
    );
  });

  it('M04 reports a canonical Rule UPDATE as invalid-schema', async () => {
    const legacy = await createClient(
      'legacy-rule-update',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-rule-update',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await establishExistingRow(legacy, budgetClient);
    await stageUpdate(budgetClient, { rule_assignment: CANONICAL_RULE });
    expectSuccessfulSync(await syncClient(budgetClient));

    const error = expectInvalidSchema(await syncClient(legacy));
    const meta = requireSqlMeta(error);

    expect(meta.query.sql).toContain('UPDATE');
    expect(meta.query.params).toContain(CANONICAL_RULE);
    expect(meta.error.message).toBe('no such column: rule_assignment');
    expect(getSyncError(error.reason, legacy.name, error.meta)).toBe(
      SCHEMA_MISMATCH_TEXT,
    );
  });

  it('M05 exposes a synthetic invalid Rule in fullSync SQL metadata', async () => {
    const legacy = await createClient(
      'legacy-sentinel',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-sentinel',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await establishExistingRow(legacy, budgetClient);
    await stageUpdate(budgetClient, { rule_assignment: INVALID_RULE_SENTINEL });
    expectSuccessfulSync(await syncClient(budgetClient));

    const result = await syncClient(legacy);
    const error = expectInvalidSchema(result);
    const meta = requireSqlMeta(error);

    expect(meta.query.params).toContain(INVALID_RULE_SENTINEL);
    expect(JSON.stringify(error.meta)).toContain(INVALID_RULE_SENTINEL);
    expect(JSON.stringify(result)).toContain(INVALID_RULE_SENTINEL);
  });

  it('M06 treats an unknown null cell as invalid-schema', async () => {
    const legacy = await createClient(
      'legacy-null',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-null',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await establishExistingRow(legacy, budgetClient);
    await stageUpdate(budgetClient, { rule_assignment: null });
    expectSuccessfulSync(await syncClient(budgetClient));

    const error = expectInvalidSchema(await syncClient(legacy));
    const meta = requireSqlMeta(error);

    expect(meta.query.params).toContain(null);
    expect(meta.error.message).toBe('no such column: rule_assignment');
  });

  it.each([
    {
      name: 'known cell before unknown cell',
      values: { known_value: 20, manual_budget_period: 202411 },
      failingColumn: 'manual_budget_period',
      knownIsEarlier: true,
    },
    {
      name: 'unknown cell before known cell',
      values: { manual_budget_period: 202411, known_value: 20 },
      failingColumn: 'manual_budget_period',
      knownIsEarlier: false,
    },
  ])(
    'M07 rolls back a mixed HULC order: $name',
    async ({ values, failingColumn, knownIsEarlier }) => {
      const legacy = await createClient(
        'legacy-mixed',
        'legacy',
        'LEGACY0000000001',
      );
      const budgetClient = await createClient(
        'new-mixed',
        'budget-fr',
        'BUDGETFR00000001',
      );
      await establishExistingRow(legacy, budgetClient);
      await stageUpdate(budgetClient, values);
      expectSuccessfulSync(await syncClient(budgetClient));

      const mixedMessages = serverMessagesForRow().filter(
        item =>
          (item.column === 'known_value' && item.value === 20) ||
          item.column === 'manual_budget_period',
      );
      const known = mixedMessages.find(item => item.column === 'known_value');
      const unknown = mixedMessages.find(
        item => item.column === 'manual_budget_period',
      );
      if (known === undefined || unknown === undefined) {
        throw new Error('Expected both mixed-batch cells on the mock server');
      }
      expect(known.timestamp.toString() < unknown.timestamp.toString()).toBe(
        knownIsEarlier,
      );

      const before = await snapshot(legacy);
      const error = expectInvalidSchema(await syncClient(legacy));
      const after = await snapshot(legacy);

      expect(requireSqlMeta(error).query.sql).toContain(failingColumn);
      expect(persistentPart(after)).toEqual(persistentPart(before));
      expect(after.hulc > before.hulc).toBe(true);
    },
  );

  it.each([
    {
      name: 'known then Manual then Rule',
      values: {
        known_value: 30,
        manual_budget_period: 202411,
        rule_assignment: CANONICAL_RULE,
      },
      failingColumn: 'manual_budget_period',
      otherUnknownColumn: 'rule_assignment',
      knownIsFirst: true,
    },
    {
      name: 'Rule then Manual then known',
      values: {
        rule_assignment: CANONICAL_RULE,
        manual_budget_period: 202411,
        known_value: 30,
      },
      failingColumn: 'rule_assignment',
      otherUnknownColumn: 'manual_budget_period',
      knownIsFirst: false,
    },
  ])(
    'M08 fails atomically with two unknown cells: $name',
    async ({ values, failingColumn, otherUnknownColumn, knownIsFirst }) => {
      const legacy = await createClient(
        'legacy-two-cells',
        'legacy',
        'LEGACY0000000001',
      );
      const budgetClient = await createClient(
        'new-two-cells',
        'budget-fr',
        'BUDGETFR00000001',
      );
      await establishExistingRow(legacy, budgetClient);
      await stageUpdate(budgetClient, values);
      expectSuccessfulSync(await syncClient(budgetClient));

      const planMessages = serverMessagesForRow().filter(
        item =>
          (item.column === 'known_value' && item.value === 30) ||
          item.column === 'manual_budget_period' ||
          item.column === 'rule_assignment',
      );
      expect(planMessages).toHaveLength(3);
      const known = planMessages.find(item => item.column === 'known_value');
      const failingUnknown = planMessages.find(
        item => item.column === failingColumn,
      );
      const otherUnknown = planMessages.find(
        item => item.column === otherUnknownColumn,
      );
      if (
        known === undefined ||
        failingUnknown === undefined ||
        otherUnknown === undefined
      ) {
        throw new Error('Expected the known cell and both unknown cells');
      }
      if (knownIsFirst) {
        expect(
          known.timestamp.toString() < failingUnknown.timestamp.toString(),
        ).toBe(true);
        expect(
          failingUnknown.timestamp.toString() <
            otherUnknown.timestamp.toString(),
        ).toBe(true);
      } else {
        expect(
          failingUnknown.timestamp.toString() <
            otherUnknown.timestamp.toString(),
        ).toBe(true);
        expect(
          otherUnknown.timestamp.toString() < known.timestamp.toString(),
        ).toBe(true);
      }

      const before = await snapshot(legacy);
      const error = expectInvalidSchema(await syncClient(legacy));
      const after = await snapshot(legacy);
      const meta = requireSqlMeta(error);

      expect(meta.query.sql).toContain(failingColumn);
      expect(meta.error.message).toBe(`no such column: ${failingColumn}`);
      expect(persistentPart(after)).toEqual(persistentPart(before));
    },
  );

  it('M09 preserves an outgoing legacy message on the server before inbound failure', async () => {
    const budgetClient = await createClient(
      'new-source',
      'budget-fr',
      'BUDGETFR00000001',
    );
    const legacy = await createClient(
      'legacy-partial',
      'legacy',
      'LEGACY0000000001',
    );
    const observer = await createClient(
      'new-observer',
      'budget-fr',
      'BUDGETFR00000002',
    );

    await stageUpdate(budgetClient, {
      known_value: 1,
      manual_budget_period: 202411,
      rule_assignment: CANONICAL_RULE,
    });
    expectSuccessfulSync(await syncClient(budgetClient));

    await stageUpdate(legacy, { known_value: 99 });
    const legacyBefore = await snapshot(legacy);
    expectInvalidSchema(await syncClient(legacy));
    const legacyAfter = await snapshot(legacy);

    expect(persistentPart(legacyAfter)).toEqual(persistentPart(legacyBefore));
    expect(
      serverMessagesForRow().some(
        item => item.column === 'known_value' && item.value === 99,
      ),
    ).toBe(true);

    expectSuccessfulSync(await syncClient(observer));
    expect(await readRow(observer)).toEqual({
      id: ROW_ID,
      known_value: 99,
      manual_budget_period: 202411,
      rule_assignment: CANONICAL_RULE,
    });
  });

  it('M10 replays the same blocking server history on the same legacy client', async () => {
    const legacy = await createClient(
      'legacy-replay',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-replay',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await establishExistingRow(legacy, budgetClient);
    await stageUpdate(budgetClient, { manual_budget_period: 202411 });
    expectSuccessfulSync(await syncClient(budgetClient));

    const before = await snapshot(legacy);
    const firstError = expectInvalidSchema(await syncClient(legacy));
    const afterFirst = await snapshot(legacy);
    const serverCountAfterFirst = mockSyncServer.getMessages().length;
    const secondError = expectInvalidSchema(await syncClient(legacy));
    const afterSecond = await snapshot(legacy);

    expect(requireSqlMeta(firstError).error.message).toBe(
      requireSqlMeta(secondError).error.message,
    );
    expect(persistentPart(afterFirst)).toEqual(persistentPart(before));
    expect(persistentPart(afterSecond)).toEqual(persistentPart(before));
    expect(afterFirst.hulc > before.hulc).toBe(true);
    expect(afterSecond.hulc > afterFirst.hulc).toBe(true);
    expect(mockSyncServer.getMessages()).toHaveLength(serverCountAfterFirst);
  });

  it('M11 resumes on the same client after adding the missing columns', async () => {
    const legacy = await createClient(
      'legacy-upgrade',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-upgrade',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await establishExistingRow(legacy, budgetClient);
    await stageUpdate(budgetClient, {
      manual_budget_period: 202411,
      rule_assignment: CANONICAL_RULE,
    });
    expectSuccessfulSync(await syncClient(budgetClient));

    expectInvalidSchema(await syncClient(legacy));
    await addBudgetColumns(legacy);
    expectSuccessfulSync(await syncClient(legacy));

    expect(await readRow(legacy)).toEqual({
      id: ROW_ID,
      known_value: 10,
      manual_budget_period: 202411,
      rule_assignment: CANONICAL_RULE,
    });
    expect(getClock().merkle).toEqual(mockSyncServer.getClock().merkle);
  });

  it('M12 preserves value/value and value/null LWW conflicts after upgrade', async () => {
    const legacy = await createClient(
      'legacy-conflicts',
      'legacy',
      'LEGACY0000000001',
    );
    await addBudgetColumns(legacy);
    await activateClient(legacy);

    const olderManual = message(
      'BUDGETFR00000001',
      'manual_budget_period',
      202410,
      1000,
    );
    const newerManual = message(
      'BUDGETFR00000002',
      'manual_budget_period',
      202411,
      2000,
    );
    const olderRule = message(
      'BUDGETFR00000001',
      'rule_assignment',
      CANONICAL_RULE,
      3000,
    );
    const newerRuleNull = message(
      'BUDGETFR00000002',
      'rule_assignment',
      null,
      4000,
    );

    await receiveMessages([newerManual, olderManual]);
    await receiveMessages([newerRuleNull, olderRule]);

    expect(await readRow(legacy)).toEqual({
      id: ROW_ID,
      known_value: null,
      manual_budget_period: 202411,
      rule_assignment: null,
    });
  });

  it('M13 exposes a distinct INSERT error that the shared classifier does not recognize', async () => {
    const legacy = await createClient(
      'legacy-insert',
      'legacy',
      'LEGACY0000000001',
    );
    const budgetClient = await createClient(
      'new-insert',
      'budget-fr',
      'BUDGETFR00000001',
    );
    await stageUpdate(budgetClient, { rule_assignment: INVALID_RULE_SENTINEL });
    expectSuccessfulSync(await syncClient(budgetClient));

    const before = await snapshot(legacy);
    const error = expectInvalidSchema(await syncClient(legacy));
    const after = await snapshot(legacy);
    const meta = requireSqlMeta(error);

    expect(persistentPart(after)).toEqual(persistentPart(before));
    expect(meta.query.sql).toContain('INSERT');
    expect(meta.query.params).toContain(INVALID_RULE_SENTINEL);
    expect(meta.error.message).toBe(
      `table ${DATASET} has no column named rule_assignment`,
    );
    expect(getSyncError(error.reason, legacy.name, error.meta)).toBe(
      `We had an unknown problem opening "${legacy.name}".`,
    );
  });
});
