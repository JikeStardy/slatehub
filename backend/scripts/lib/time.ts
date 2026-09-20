import { readEnv } from './env';

export const DEFAULT_SCRIPT_TIME_ZONE = 'Asia/Shanghai';

interface ZonedMinuteParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  weekdayIndex: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function readScriptTimeZone(): string {
  const timeZone = readEnv('SLATEHUB_JOB_TIME_ZONE') || DEFAULT_SCRIPT_TIME_ZONE;
  validateTimeZone(timeZone);
  return timeZone;
}

export function formatMonthDayMinuteInTimeZone(date: Date, timeZone: string): string {
  const parts = minutePartsInTimeZone(date, timeZone);
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatHourMinuteInTimeZone(date: Date, timeZone: string): string {
  const parts = minutePartsInTimeZone(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function weekdayIndexInTimeZone(date: Date, timeZone: string): number {
  return minutePartsInTimeZone(date, timeZone).weekdayIndex;
}

export function sameLocalDateInTimeZone(a: Date, b: Date, timeZone: string): boolean {
  const left = minutePartsInTimeZone(a, timeZone);
  const right = minutePartsInTimeZone(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function minutePartsInTimeZone(date: Date, timeZone: string): ZonedMinuteParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const weekday = requirePart(parts, 'weekday');
  const weekdayIndex = WEEKDAY_INDEX[weekday];
  if (weekdayIndex === undefined) {
    throw new Error(`Unsupported weekday value ${weekday} for time zone ${timeZone}.`);
  }

  return {
    year: requirePart(parts, 'year'),
    month: requirePart(parts, 'month'),
    day: requirePart(parts, 'day'),
    hour: requirePart(parts, 'hour'),
    minute: requirePart(parts, 'minute'),
    weekdayIndex,
  };
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch (error) {
    throw new Error(
      `Invalid script time zone ${timeZone}. Set SLATEHUB_JOB_TIME_ZONE to an IANA time zone.`,
      { cause: error }
    );
  }
}

function requirePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Intl.DateTimeFormat did not return ${type}.`);
  }
  return value;
}
