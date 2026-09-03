import { getMonth, isValidYearMonth, isValidYearMonthDay } from './months';

declare const budgetPeriodBrand: unique symbol;

export type BudgetPeriod = string & {
  readonly [budgetPeriodBrand]: true;
};

export type RuleAssignment = Readonly<{
  period: BudgetPeriod;
  ruleId: string;
}>;

export type BudgetPeriodSource = 'manual' | 'rule' | 'default';

export type BudgetPeriodProjection = Readonly<{
  budgetPeriod: BudgetPeriod;
  budgetPeriodSource: BudgetPeriodSource;
}>;

export type BudgetPeriodErrorCode =
  | 'invalid-budget-period'
  | 'invalid-bank-date'
  | 'rule-assignment-not-json-string'
  | 'rule-assignment-invalid-json'
  | 'rule-assignment-not-object'
  | 'rule-assignment-invalid-keys'
  | 'rule-assignment-invalid-period'
  | 'rule-assignment-invalid-rule-id'
  | 'rule-assignment-non-canonical-json';

export type BudgetPeriodResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: BudgetPeriodErrorCode }>;
    }>;

type BudgetPeriodInput = Readonly<{
  bankDate: string;
  manualBudgetPeriod: unknown;
  ruleAssignment: unknown;
}>;

function success<T>(value: T): BudgetPeriodResult<T> {
  return { ok: true, value };
}

function failure(code: BudgetPeriodErrorCode): BudgetPeriodResult<never> {
  return { ok: false, error: { code } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBudgetPeriod(value: unknown): value is BudgetPeriod {
  return typeof value === 'string' && isValidYearMonth(value);
}

export function parseBudgetPeriod(
  value: unknown,
): BudgetPeriodResult<BudgetPeriod> {
  return isBudgetPeriod(value)
    ? success(value)
    : failure('invalid-budget-period');
}

export function validateRuleAssignment(
  value: unknown,
): BudgetPeriodResult<RuleAssignment> {
  if (!isRecord(value)) {
    return failure('rule-assignment-not-object');
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, 'period') ||
    !Object.hasOwn(value, 'ruleId')
  ) {
    return failure('rule-assignment-invalid-keys');
  }

  const period = parseBudgetPeriod(value.period);
  if (!period.ok) {
    return failure('rule-assignment-invalid-period');
  }

  if (typeof value.ruleId !== 'string' || value.ruleId.length === 0) {
    return failure('rule-assignment-invalid-rule-id');
  }

  return success({ period: period.value, ruleId: value.ruleId });
}

function stringifyRuleAssignment(assignment: RuleAssignment): string {
  const canonicalAssignment = {
    period: assignment.period,
    ruleId: assignment.ruleId,
  };

  return JSON.stringify(canonicalAssignment);
}

export function encodeRuleAssignment(
  value: unknown,
): BudgetPeriodResult<string> {
  const assignment = validateRuleAssignment(value);
  if (assignment.ok === false) {
    return failure(assignment.error.code);
  }

  return success(stringifyRuleAssignment(assignment.value));
}

export function decodeRuleAssignment(
  value: unknown,
): BudgetPeriodResult<RuleAssignment> {
  if (typeof value !== 'string') {
    return failure('rule-assignment-not-json-string');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return failure('rule-assignment-invalid-json');
  }

  const assignment = validateRuleAssignment(parsed);
  if (assignment.ok === false) {
    return failure(assignment.error.code);
  }

  if (stringifyRuleAssignment(assignment.value) !== value) {
    return failure('rule-assignment-non-canonical-json');
  }

  return assignment;
}

export function deriveBudgetPeriod(
  input: BudgetPeriodInput,
): BudgetPeriodResult<BudgetPeriodProjection> {
  if (!isValidYearMonthDay(input.bankDate)) {
    return failure('invalid-bank-date');
  }

  let manualBudgetPeriod: BudgetPeriod | null = null;
  if (input.manualBudgetPeriod !== null) {
    const manual = parseBudgetPeriod(input.manualBudgetPeriod);
    if (manual.ok === false) {
      return failure(manual.error.code);
    }
    manualBudgetPeriod = manual.value;
  }

  let ruleAssignment: RuleAssignment | null = null;
  if (input.ruleAssignment !== null) {
    const rule = validateRuleAssignment(input.ruleAssignment);
    if (rule.ok === false) {
      return failure(rule.error.code);
    }
    ruleAssignment = rule.value;
  }

  if (manualBudgetPeriod !== null) {
    return success({
      budgetPeriod: manualBudgetPeriod,
      budgetPeriodSource: 'manual',
    });
  }

  if (ruleAssignment !== null) {
    return success({
      budgetPeriod: ruleAssignment.period,
      budgetPeriodSource: 'rule',
    });
  }

  const defaultBudgetPeriod = getMonth(input.bankDate);
  if (!isBudgetPeriod(defaultBudgetPeriod)) {
    return failure('invalid-bank-date');
  }

  return success({
    budgetPeriod: defaultBudgetPeriod,
    budgetPeriodSource: 'default',
  });
}
