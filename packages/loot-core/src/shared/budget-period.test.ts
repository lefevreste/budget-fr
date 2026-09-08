import { describe, expect, it } from 'vitest';

import {
  decodeRuleAssignment,
  deriveBudgetPeriod,
  encodeRuleAssignment,
  isBudgetPeriod,
  parseBudgetPeriod,
  validateRuleAssignment,
} from './budget-period';
import type {
  BudgetPeriod,
  BudgetPeriodErrorCode,
  BudgetPeriodResult,
  RuleAssignment,
} from './budget-period';

function expectOk<T>(result: BudgetPeriodResult<T>): T {
  expect(result.ok).toBe(true);
  if (result.ok === false) {
    throw new Error(`Expected success, received ${result.error.code}`);
  }
  return result.value;
}

function expectError<T>(
  result: BudgetPeriodResult<T>,
  code: BudgetPeriodErrorCode,
): void {
  expect(result).toEqual({ ok: false, error: { code } });
}

function period(value: string): BudgetPeriod {
  return expectOk(parseBudgetPeriod(value));
}

function ruleAssignment(
  value: Readonly<{ period: string; ruleId: string }> = {
    period: '2024-10',
    ruleId: 'rule-1',
  },
): RuleAssignment {
  return expectOk(validateRuleAssignment(value));
}

describe('BudgetPeriod', () => {
  it('accepts a valid YYYY-MM period', () => {
    expect(isBudgetPeriod('2024-10')).toBe(true);
    expect(expectOk(parseBudgetPeriod('2024-10'))).toBe('2024-10');
  });

  it.each([
    '2024-00',
    '2024-13',
    '2024-1',
    '24-10',
    '2024-10-01',
    '',
    null,
    202410,
  ])('rejects the invalid period %j', value => {
    expect(isBudgetPeriod(value)).toBe(false);
    expectError(parseBudgetPeriod(value), 'invalid-budget-period');
  });
});

describe('RuleAssignment validation and canonical JSON', () => {
  it('encodes the reference assignment exactly', () => {
    expect(
      expectOk(encodeRuleAssignment({ period: '2024-10', ruleId: 'rule-1' })),
    ).toBe('{"period":"2024-10","ruleId":"rule-1"}');
  });

  it.each([
    {},
    { period: '2024-10' },
    { ruleId: 'rule-1' },
    { period: '2024-10', ruleId: 'rule-1', extra: true },
  ])('rejects missing or additional keys in %j', value => {
    expectError(validateRuleAssignment(value), 'rule-assignment-invalid-keys');
  });

  it.each([null, [], 'not-an-object', 42])(
    'rejects the non-object assignment %j',
    value => {
      expectError(validateRuleAssignment(value), 'rule-assignment-not-object');
    },
  );

  it.each([
    { period: 202410, ruleId: 'rule-1' },
    { period: '2024-13', ruleId: 'rule-1' },
  ])('rejects an assignment with invalid period %j', value => {
    expectError(
      validateRuleAssignment(value),
      'rule-assignment-invalid-period',
    );
  });

  it.each([
    { period: '2024-10', ruleId: '' },
    { period: '2024-10', ruleId: 12 },
  ])('rejects an assignment with invalid ruleId %j', value => {
    expectError(
      validateRuleAssignment(value),
      'rule-assignment-invalid-rule-id',
    );
  });

  it('does not invent restrictions for a non-empty ruleId', () => {
    expect(
      expectOk(validateRuleAssignment({ period: '0000-01', ruleId: '   ' })),
    ).toEqual({ period: '0000-01', ruleId: '   ' });
  });

  it('rejects a decoder input that is not a JSON string', () => {
    expectError(
      decodeRuleAssignment({ period: '2024-10', ruleId: 'rule-1' }),
      'rule-assignment-not-json-string',
    );
  });

  it.each(['{', '{"period":"2024-10"'])('rejects invalid JSON %j', value => {
    expectError(decodeRuleAssignment(value), 'rule-assignment-invalid-json');
  });

  it.each([
    ['null', 'rule-assignment-not-object'],
    ['[]', 'rule-assignment-not-object'],
    ['{"period":"2024-10"}', 'rule-assignment-invalid-keys'],
    [
      '{"period":"2024-10","ruleId":"rule-1","extra":true}',
      'rule-assignment-invalid-keys',
    ],
    ['{"period":202410,"ruleId":"rule-1"}', 'rule-assignment-invalid-period'],
    ['{"period":"2024-10","ruleId":1}', 'rule-assignment-invalid-rule-id'],
    ['{"period":"2024-10","ruleId":""}', 'rule-assignment-invalid-rule-id'],
  ] as const)('rejects invalid decoded shape %j', (value, code) => {
    expectError(decodeRuleAssignment(value), code);
  });

  it.each([
    '{"ruleId":"rule-1","period":"2024-10"}',
    '{ "period": "2024-10", "ruleId": "rule-1" }',
    '{"period":"2024-10","period":"2024-10","ruleId":"rule-1"}',
  ])('rejects non-canonical JSON %j', value => {
    expectError(
      decodeRuleAssignment(value),
      'rule-assignment-non-canonical-json',
    );
  });

  it('round-trips canonical JSON', () => {
    const assignment = ruleAssignment({
      period: '2024-12',
      ruleId: 'rule-2',
    });
    const encoded = expectOk(encodeRuleAssignment(assignment));

    expect(expectOk(decodeRuleAssignment(encoded))).toEqual(assignment);
  });

  it('round-trips quotes, backslashes and Unicode in ruleId', () => {
    const assignment = ruleAssignment({
      period: '2024-10',
      ruleId: 'rule-"quoted"\\path-é-漢字',
    });
    const encoded = expectOk(encodeRuleAssignment(assignment));

    expect(encoded).toBe(
      '{"period":"2024-10","ruleId":"rule-\\"quoted\\"\\\\path-é-漢字"}',
    );
    expect(expectOk(decodeRuleAssignment(encoded))).toEqual(assignment);
  });

  it('returns only an error for invalid decoded data and never Default', () => {
    const result = decodeRuleAssignment(
      '{"period":"2024-13","ruleId":"rule-1"}',
    );

    expectError(result, 'rule-assignment-invalid-period');
    expect(Object.hasOwn(result, 'value')).toBe(false);
  });
});

describe('budget period projection', () => {
  it('uses Manual when it is the only assignment', () => {
    expect(
      expectOk(
        deriveBudgetPeriod({
          bankDate: '2024-09-15',
          manualBudgetPeriod: period('2024-11'),
          ruleAssignment: null,
        }),
      ),
    ).toEqual({ budgetPeriod: '2024-11', budgetPeriodSource: 'manual' });
  });

  it('uses Rule when it is the only assignment', () => {
    expect(
      expectOk(
        deriveBudgetPeriod({
          bankDate: '2024-09-15',
          manualBudgetPeriod: null,
          ruleAssignment: ruleAssignment(),
        }),
      ),
    ).toEqual({ budgetPeriod: '2024-10', budgetPeriodSource: 'rule' });
  });

  it('derives Default from the month of bankDate', () => {
    expect(
      expectOk(
        deriveBudgetPeriod({
          bankDate: '2026-08-28',
          manualBudgetPeriod: null,
          ruleAssignment: null,
        }),
      ),
    ).toEqual({ budgetPeriod: '2026-08', budgetPeriodSource: 'default' });
  });

  it('keeps Manual effective when Rule is also present', () => {
    expect(
      expectOk(
        deriveBudgetPeriod({
          bankDate: '2024-09-15',
          manualBudgetPeriod: period('2024-11'),
          ruleAssignment: ruleAssignment(),
        }),
      ),
    ).toEqual({ budgetPeriod: '2024-11', budgetPeriodSource: 'manual' });
  });

  it('reveals Rule after conceptual deletion of Manual', () => {
    const assignment = ruleAssignment();
    const withManual = deriveBudgetPeriod({
      bankDate: '2024-09-15',
      manualBudgetPeriod: period('2024-11'),
      ruleAssignment: assignment,
    });
    const withoutManual = deriveBudgetPeriod({
      bankDate: '2024-09-15',
      manualBudgetPeriod: null,
      ruleAssignment: assignment,
    });

    expect(expectOk(withManual)).toEqual({
      budgetPeriod: '2024-11',
      budgetPeriodSource: 'manual',
    });
    expect(expectOk(withoutManual)).toEqual({
      budgetPeriod: '2024-10',
      budgetPeriodSource: 'rule',
    });
  });

  it.each(['2024-02-30', '2024-13-01', '2024-10'])(
    'rejects the invalid bankDate %j',
    bankDate => {
      expectError(
        deriveBudgetPeriod({
          bankDate,
          manualBudgetPeriod: null,
          ruleAssignment: null,
        }),
        'invalid-bank-date',
      );
    },
  );

  it('does not modify bankDate or the input object', () => {
    const assignment = Object.freeze(ruleAssignment());
    const input = Object.freeze({
      bankDate: '2026-08-28',
      manualBudgetPeriod: period('2026-09'),
      ruleAssignment: assignment,
    });
    const before = JSON.stringify(input);

    expectOk(deriveBudgetPeriod(input));

    expect(input.bankDate).toBe('2026-08-28');
    expect(JSON.stringify(input)).toBe(before);
  });
});
