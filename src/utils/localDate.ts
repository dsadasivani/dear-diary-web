const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number): string => String(value).padStart(2, '0');

const assertDate = (date: Date): void => {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date value.');
};

export const isLocalDateKey = (value: string): boolean => {
  const match = value.match(DATE_KEY_PATTERN);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  return (
    parsed.getFullYear() === Number(year) &&
    parsed.getMonth() === Number(month) - 1 &&
    parsed.getDate() === Number(day)
  );
};

export const toLocalDateKey = (value: Date | number = new Date(), timeZone?: string): string => {
  const date = value instanceof Date ? value : new Date(value);
  assertDate(date);
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    return `${read('year')}-${read('month')}-${read('day')}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const fromLocalDateKey = (key: string): Date => {
  if (!isLocalDateKey(key)) throw new RangeError(`Invalid local date key: ${key}`);
  const [, year, month, day] = key.match(DATE_KEY_PATTERN)!;
  return new Date(Number(year), Number(month) - 1, Number(day));
};

export const isSameLocalDay = (left: Date | number, right: Date | number): boolean =>
  toLocalDateKey(left) === toLocalDateKey(right);

export const getLocalDayRange = (value: Date | number = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  assertDate(date);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start, end };
};

export const formatEntryDate = (
  dateKey: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  },
  locale?: string | string[],
): string => new Intl.DateTimeFormat(locale, options).format(fromLocalDateKey(dateKey));

export const calculateLocalStreak = (
  dateKeys: Iterable<string>,
  today: Date | number = new Date(),
): number => {
  const unique = new Set(Array.from(dateKeys).filter(isLocalDateKey));
  if (!unique.size) return 0;
  const cursor = fromLocalDateKey(toLocalDateKey(today));
  if (!unique.has(toLocalDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (unique.has(toLocalDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
};
